/** Thin PDF.js boundary; viewer state should not depend on file loading details. */
export class PdfDocumentService {
  constructor(pdfjs) {
    this.pdfjs = pdfjs;
  }

  async open(file) {
    return this.pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  }

  getPage(document, pageNumber) {
    return document.getPage(pageNumber);
  }

  getOperatorList(page) {
    return page.getOperatorList();
  }

  getTextContent(page) {
    return page.getTextContent();
  }
}
