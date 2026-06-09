interface Window {
  api: {
    listProperties: () => Promise<any[]>;
    createProperty: (data: any) => Promise<number>;
    updateProperty: (data: any) => Promise<void>;
    deleteProperty: (id: number) => Promise<void>;
    selectImage: () => Promise<string | null>;

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
