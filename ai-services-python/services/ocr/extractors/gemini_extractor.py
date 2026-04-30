"""
Gemini Vision OCR Extractor
============================
Drop-in replacement for PaddleOCR on memory-constrained deployments (free tier).

Instead of loading a 350 MB local PaddleOCR model, this extractor sends the
image to the Gemini Vision API and asks it to extract text. Zero local RAM
overhead beyond what Python/FastAPI already uses.

Activated automatically when USE_PADDLE_OCR=false (the default).
"""
import io
import time
from loguru import logger
from PIL import Image
from .base import DocumentExtractor, DocumentResult, PageResult


class GeminiVisionExtractor(DocumentExtractor):
    """
    Uses Gemini Vision API to extract text from a single image.
    Drop-in for PaddleOcrExtractor.
    """

    async def extract(self, file_bytes: bytes, filename: str) -> DocumentResult:
        import google.generativeai as genai
        from config.settings import get_settings
        settings = get_settings()

        result = DocumentResult(page_count=1)

        try:
            genai.configure(api_key=settings.GEMINI_API_KEY)
            model = genai.GenerativeModel(settings.GEMINI_FLASH_MODEL)

            img = Image.open(io.BytesIO(file_bytes)).convert("RGB")

            response = model.generate_content([
                "Extract ALL text from this document image exactly as it appears. "
                "Preserve all numbers, tables, dates, names, and structure faithfully. "
                "Return only the extracted text with no commentary or markdown formatting.",
                img,
            ])

            text = response.text.strip() if response.text else ""
            confidence = 85.0 if text else 0.0

            result.raw_text = text
            result.confidence_score = confidence
            result.word_count = len(text.split())
            result.char_count = len(text)
            result.page_results = [PageResult(
                page_number=1,
                text=text,
                confidence=confidence,
                word_count=result.word_count,
                char_count=result.char_count,
            )]

        except Exception as e:
            logger.error(f"[GeminiVisionExtractor] Failed on '{filename}': {e}")

        return result


class GeminiScannedPdfExtractor(DocumentExtractor):
    """
    Converts each PDF page to an image, then runs GeminiVisionExtractor.
    Drop-in for ScannedPdfOcrExtractor.
    """

    async def extract(self, file_bytes: bytes, filename: str) -> DocumentResult:
        from pdf2image import convert_from_bytes
        from config.settings import get_settings
        settings = get_settings()

        result = DocumentResult(pdf_type="scanned")

        try:
            images = convert_from_bytes(file_bytes, dpi=settings.PDF_DPI, fmt="PNG")
            result.page_count = len(images)
        except Exception as e:
            logger.error(f"[GeminiScannedPdfExtractor] PDF->image failed: {e}")
            return result

        image_extractor = GeminiVisionExtractor()
        all_texts = []
        all_confidences = []
        page_results = []

        for idx, pil_image in enumerate(images, 1):
            page_start = time.time()
            buf = io.BytesIO()
            pil_image.save(buf, format="PNG")

            page_doc = await image_extractor.extract(buf.getvalue(), f"page_{idx}.png")

            all_texts.append(page_doc.raw_text)
            all_confidences.append(page_doc.confidence_score)
            page_results.append(PageResult(
                page_number=idx,
                text=page_doc.raw_text,
                confidence=page_doc.confidence_score,
                word_count=page_doc.word_count,
                char_count=page_doc.char_count,
                processing_time_ms=int((time.time() - page_start) * 1000),
            ))

        result.raw_text = "\n\n".join(all_texts)
        result.page_results = page_results
        result.word_count = len(result.raw_text.split())
        result.char_count = len(result.raw_text)
        result.confidence_score = (
            sum(all_confidences) / len(all_confidences) if all_confidences else 0.0
        )
        return result
