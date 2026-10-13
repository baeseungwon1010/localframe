/** A minimal PDF writer: one JPEG image per page. No dependencies. */

export type PdfPage = {
  jpeg: Uint8Array;
  /** Image size in pixels. */
  pxWidth: number;
  pxHeight: number;
  /** Page size in points (1/72 inch). */
  ptWidth: number;
  ptHeight: number;
};

const enc = new TextEncoder();

export function buildPdf(pages: PdfPage[], title = 'Export'): Blob {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b;
    chunks.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  const num = (v: number) => (Math.round(v * 100) / 100).toString();
  // PDF strings: escape \, ( and ); keep ASCII only
  const pdfString = (s: string) => `(${s.replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1')})`;

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const pageObj = (i: number) => 4 + i * 3;
  const total = 3 + pages.length * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title ${pdfString(title)} /Producer (localframe) >>`));
  pages.forEach((p, i) => {
    const pageN = pageObj(i);
    const imgN = pageN + 1;
    const contentN = pageN + 2;
    obj(pageN, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.ptWidth)} ${num(p.ptHeight)}] ` +
          `/Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contentN} 0 R >>`,
      ),
    );
    obj(imgN, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${p.pxWidth} /Height ${p.pxHeight} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      );
      push(p.jpeg);
      push('\nendstream');
    });
    const content = `q ${num(p.ptWidth)} 0 0 ${num(p.ptHeight)} 0 0 cm /Im0 Do Q`;
    obj(contentN, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });
  const xref = length;
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= total; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}
