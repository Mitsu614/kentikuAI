interface Window {
  api: {
    listProperties: () => Promise<any[]>;
    createProperty: (data: any) => Promise<number>;
    updateProperty: (data: any) => Promise<void>;
    deleteProperty: (id: number) => Promise<void>;
    selectImage: () => Promise<string | null>;
    selectPdf: () => Promise<{ page: number; type?: string; data: string }[] | null>;

    onAiProgress: (cb: (p: { stage: string; items: number }) => void) => () => void;

    // 見積の原価・売価の修正（上書き保存／元に戻す）
    saveCostEdit: (data: { constructionId: number; materialCost: number; laborCost: number; expenseCost: number; total: number }) => Promise<any>;
    revertCostEdit: (data: { constructionId: number }) => Promise<any>;
    getCostEdit: (constructionId: number) => Promise<any>;

    // 図面からの数量拾い出し（Takeoff）
    takeoffDrawing: (data: { files: { type?: string; data: string; name?: string }[]; comment?: string; scaleHint?: string; targets?: string }) => Promise<any>;
    takeoffHistory: () => Promise<any[]>;
    generateTakeoffPDF: (data: { takeoff: any; title?: string; clientName?: string }) => Promise<boolean>;

    listMaterials: () => Promise<any[]>;
    createMaterial: (data: any) => Promise<number>;
    updateMaterial: (data: any) => Promise<void>;
    deleteMaterial: (id: number) => Promise<void>;

    listConstructions: () => Promise<any[]>;
    createConstruction: (data: any) => Promise<number>;
    updateConstruction: (data: any) => Promise<void>;
    deleteConstruction: (id: number) => Promise<void>;
    calculateConstruction: (id: number) => Promise<any>;

    listConstructionMaterials: (constructionId: number) => Promise<any[]>;
    addConstructionMaterial: (data: any) => Promise<number>;
    removeConstructionMaterial: (id: number) => Promise<void>;

    listInvoices: () => Promise<any[]>;
    createInvoice: (data: any) => Promise<number>;
    updateInvoice: (data: any) => Promise<void>;
    deleteInvoice: (id: number) => Promise<void>;
    getInvoiceDetail: (id: number) => Promise<any>;
    generatePDF: (data: any) => Promise<void>;
    getDashboardSummary: () => Promise<{ totalMaterialCost: number; totalSelling: number; totalGrossProfit: number; profitRate: number }>;
  };
}
