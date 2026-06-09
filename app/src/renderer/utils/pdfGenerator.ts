// Electron の printToPDF を使うため、メインプロセスに委譲
export async function generateInvoicePDF(invoice: any, materials: any[]) {
  await (window as any).api.generatePDF({ invoice, materials });
}
