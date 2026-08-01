# CapitalScale Chunking Strategies Analysis

## 1. Executive Summary

This document outlines the deterministic, layout-aware document chunking architecture implemented in the CapitalScale underwriting platform. The system eschews generic, naive LLM chunking wrappers (e.g., LangChain's `RecursiveCharacterTextSplitter` or LLM-based `SemanticChunker`) in favor of highly optimized, domain-specific chunking strategies.

By analyzing the document type via MIME, extension, and content heuristics, the system routes OCR'd text into a `ChunkingStrategyFactory`. This ensures that financial tables are never vertically split, policy exceptions are always glued to their parent rules, and small orphaned paragraphs are intelligently carried forward.

---

## 2. Document Types & Strategy Mapping

Based on the implementations in `services/rag/chunking/strategies.py` and `services/rag/chunking/utils.py`, the following document types are mapped to their respective chunking strategies:

| Document Type                                | Mapped Strategy              | Max Tokens | Overlap Tokens | Target Tokens |
| -------------------------------------------- | ---------------------------- | ---------- | -------------- | ------------- |
| **Bank Policy / Credit Policy**              | `BankPolicySemanticStrategy` | 800        | 0              | 500           |
| **Bank Statement**                           | `BankStatementStrategy`      | 550        | 80             | 350           |
| **Pay Stub / Salary Slip**                   | `PayStubStrategy`            | 450        | 60             | 300           |
| **Tax Return / ITR**                         | `TaxReturnStrategy`          | 600        | 80             | 375           |
| **Appraisal / Valuation**                    | `AppraisalStrategy`          | 800        | 120            | 500           |
| **Identity Document (Aadhar/PAN/Passport)**  | `IdentityImageStrategy`      | 350        | 40             | 250           |
| **Check / Cheque**                           | `IdentityImageStrategy`      | 350        | 40             | 250           |
| **Financial Statement (P&L, Balance Sheet)** | `FinancialTableStrategy`     | 600        | 80             | 375           |
| _Unknown / General PDF_                      | `NarrativeDocumentStrategy`  | 750        | 100            | 450           |

---

## 3. The Complete Processing Pipeline

The journey of a document from upload to LLM evaluation:

1. **Document Upload**: Multi-part stream received at Node API, proxies to Python `/api/v1/ocr/process`.
2. **Document Loader Classification**: `process_document` routes by MIME/Extension. Images go to `PaddleOcrExtractor`. Native PDFs go to `PdfPlumberExtractor`. Scanned PDFs fallback to `ScannedPdfOcrExtractor`.
3. **Extraction & Table Preservation**: `pdfplumber` attempts to natively extract text and tables. If tables are found, they are converted into Markdown format (`*Table extracted from Page N* | Header | Row |...`).
4. **Normalization**: `normalize_document_type` infers the true document nature from filenames and explicit metadata.
5. **Strategy Selection**: The `ChunkingStrategyFactory` initializes the precise strategy (e.g., `BankStatementStrategy`).
6. **Block Splitting**:
   - Narrative text is split by blank lines (`split_paragraphs`).
   - Financial documents are split while protecting Markdown tables (`group_table_rows`).
7. **Post-Processing (Policies)**: `_glue_exceptions` attaches caveats/notes to parent rule blocks.
8. **Carry-Forward Merging**: `merge_small_blocks` groups adjacent blocks until they hit `target_tokens`. Any lingering orphans < 40 tokens (`CARRY_FORWARD_MAX_TOKENS`) are carried into the _next_ section to prevent isolated, meaningless chunks.
9. **Fact Extraction**: `StructuredFactExtractor` analyzes the chunk and attaches deterministic metadata (e.g., entities, dates).
10. **Embedding Generation**: Text is sent to `models/text-embedding-004` (Gemini API) to generate a 768-dimensional vector.
11. **Storage**: `upsert_document_chunks` stores the text, metadata JSONB, and vector in PostgreSQL (`pgvector`).
12. **Retrieval**: `query_similar_chunks` uses cosine distance (`<->`) to fetch the top-K chunks for the underwriting LLM prompt.

---

## 4. Deep Dive: Strategy Justifications (Interview Prep)

### A. Financial Documents (Bank Statements, Pay Stubs, Tax Returns)

**Implementation:** `FinancialTableStrategy` (and its subclasses). Uses `group_table_rows` to prevent splitting on single newlines if the text looks like a row (`|`, `\t`, or double spaces).
**Interview Question:** _"Why did you use this specific chunking strategy for bank statements?"_
**Answer:** "Bank statements are overwhelmingly tabular. If we used a standard `RecursiveCharacterTextSplitter`, it would slice a transaction row in half right down the middle of a page, separating the transaction date from the withdrawal amount. Our `FinancialTableStrategy` uses a heuristic (`group_table_rows`) to detect tabular formatting and ensures rows stay together. We opted for tighter token limits here (e.g., 550 max for statements, 450 for pay stubs) because financial RAG requires high precision; smaller chunks ensure the embedding vector represents a highly localized set of transactions, reducing the risk of the LLM hallucinating numbers from a distant row during extraction."

### B. Bank Policies & Credit Guidelines

**Implementation:** `BankPolicySemanticStrategy`. Uses 800 max tokens, 0 overlap, and a custom `block_postprocess_fn` (`_glue_exceptions`).
**Interview Question:** _"Why does your Bank Policy chunker have 0 token overlap and custom exception gluing?"_
**Answer:** "Bank credit policies are hierarchical rulebooks. We found that standard overlapping chunkers create severe logical errors: an overlap might capture a rule but miss the 'Exception' clause that immediately follows it, causing the LLM to wrongfully reject an applicant. We wrote `BankPolicySemanticStrategy` to parse the hierarchy (Chapters/Sections) into metadata. More importantly, it uses a deterministic post-processor (`_glue_exceptions`) that detects keywords like 'Exception', 'Note', or 'However', and forcefully appends them to the preceding rule chunk. We use 0 token overlap because our logical splitting guarantees structural integrity; overlap would merely duplicate rules across vectors and bloat retrieval context."

### C. Identity Documents & Checks

**Implementation:** `IdentityImageStrategy`. Small max tokens (350), small target (250).
**Interview Question:** _"Why use such a small chunk size for Identity Documents?"_
**Answer:** "Identity documents like Passports or PAN cards contain very little raw text but high informational density (Names, ID numbers, DOBs). If we padded them out to 800 tokens, the embedding would capture a lot of OCR noise or boilerplate. By keeping the target around 250 tokens, the resulting embedding is heavily biased towards the actual identity facts. We also rely heavily on our `StructuredFactExtractor` here to inject exact matches directly into the `metadata` JSONB, which allows us to do exact keyword filtering in PostgreSQL before even executing the semantic vector search."

---

## 5. Justification of Parameters

- **Why these separators?** We avoid arbitrary character splitting (like Langchain's `["\n\n", "\n", " "]`). We split logically: `split_sections` uses regex to find formal document headers, `split_paragraphs` splits on double-newlines, and `group_table_rows` respects tabular layouts.
- **Why this overlap?** Narrative documents have 100 token overlap to catch sentences crossing boundaries. Financial tables have ~80 token overlap to catch bridging rows. Bank policies have 0 overlap because structural logic prevents orphaned rules.
- **Why this metadata?** We inject `section_title`, `chapter`, `page_number`, and `ocr_confidence`. During underwriting, if a chunk has an OCR confidence of 30%, the LLM is instructed to treat that data as highly suspect, triggering a `MANUAL_REVIEW` status.
- **Why this ordering?** The `_build_units_with_carry` loop processes sequentially and carries forward orphaned blocks (< 40 tokens) to the next group. This prevents the classic RAG problem where a stray page number or floating footnote becomes its own chunk and ruins search relevancy.

---

## 6. Comparison with Alternative Strategies

| Document Type      | Our Strategy                                           | Alternative Strategy                          | Why Alternative is Worse                                                                                                                                       |
| ------------------ | ------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bank Policy**    | `BankPolicySemanticStrategy` (Rule + Exception Gluing) | LangChain `RecursiveCharacterTextSplitter`    | Blindly slices text at 1000 chars. Will inevitably separate a strict rule from its crucial "Exception" clause, leading to false loan rejections.               |
| **Bank Statement** | `FinancialTableStrategy` (Row preservation)            | LLM-based `SemanticChunker` (e.g. LlamaIndex) | LLM chunking evaluates meaning. Bank statements are just numbers. The LLM will fail to find "semantic boundaries" and cost $0.05 per page just to chunk badly. |
| **Identity Doc**   | `IdentityImageStrategy` (Small 250 token limit)        | Page-based Chunking (1 chunk = 1 page)        | The page contains massive OCR noise (watermarks, microprint). A page-level embedding dilutes the signal of the actual Name and ID number.                      |

---

## 7. Possible Future Improvements

1. **Would I keep the current setup?** Yes. For highly structured financial and legal documents, deterministic, heuristic-based chunking heavily outperforms naive chunkers and is vastly cheaper/faster than LLM-based semantic chunking.
2. **Would Semantic Chunking improve this?** No. Using an LLM to chunk bank statements or tax returns is a waste of latency and money. Numbers don't have "semantic shifts" in the way narrative essays do.
3. **Would Layout-Aware Vision chunking improve this?** **Yes.** Currently, we rely on `pdfplumber` to extract tables into Markdown. If we upgraded to a Vision-Language Model (VLM) like GPT-4o or Gemini 1.5 Pro to natively parse the bounding boxes of the PDF and generate the chunks based on visual layout, we could eliminate OCR errors in complex, nested balance sheets. _Expected improvement: 15-20% reduction in missing tabular data, but at a 10x cost increase per page._

---

## 8. Code Evidence Reference

- **Fallback to OCR:** `services/ocr/extractors/pdf_extractor.py` (`PdfPlumberExtractor._extract_sync`) checks native text density. If `< MIN_NATIVE_TEXT_DENSITY`, it gracefully falls back to PaddleOCR.
- **Exception Gluing:** `services/rag/chunking/strategies.py` (`BankPolicySemanticStrategy._glue_exceptions`) checks if a block starts with "exception", "note", or "however" and appends it to `glued_blocks[-1]`.
- **Orphan Merging:** `services/rag/chunking/strategies.py` (`_build_units_with_carry`) holds back `last_block` if `count_tokens(last_block) < self.CARRY_FORWARD_MAX_TOKENS (40)`.
- **Table Grouping:** `services/rag/chunking/utils.py` (`group_table_rows`) detects pipes `|`, tabs `\t`, or double spaces to keep row strings bundled together.
