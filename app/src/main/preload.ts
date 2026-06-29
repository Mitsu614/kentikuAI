import { contextBridge, ipcRenderer, webFrame } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // 表示倍率
  setZoom: (factor: number) => { webFrame.setZoomFactor(factor); },
  getZoom: () => webFrame.getZoomFactor(),
  // 物件
  listProperties: () => ipcRenderer.invoke('properties:list'),
  createProperty: (data: any) => ipcRenderer.invoke('properties:create', data),
  updateProperty: (data: any) => ipcRenderer.invoke('properties:update', data),
  deleteProperty: (id: number) => ipcRenderer.invoke('properties:delete', id),
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
  selectPdf: () => ipcRenderer.invoke('dialog:selectPdf'),

  // 材料マスタ
  listMaterials: () => ipcRenderer.invoke('materials:list'),
  createMaterial: (data: any) => ipcRenderer.invoke('materials:create', data),
  updateMaterial: (data: any) => ipcRenderer.invoke('materials:update', data),
  deleteMaterial: (id: number) => ipcRenderer.invoke('materials:delete', id),

  // 施工履歴
  listConstructions: () => ipcRenderer.invoke('constructions:list'),
  createConstruction: (data: any) => ipcRenderer.invoke('constructions:create', data),
  updateConstruction: (data: any) => ipcRenderer.invoke('constructions:update', data),
  deleteConstruction: (id: number) => ipcRenderer.invoke('constructions:delete', id),
  calculateConstruction: (id: number) => ipcRenderer.invoke('constructions:calculate', id),

  // 施工材料明細
  listConstructionMaterials: (cid: number) => ipcRenderer.invoke('constructionMaterials:list', cid),
  addConstructionMaterial: (data: any) => ipcRenderer.invoke('constructionMaterials:add', data),
  updateConstructionMaterial: (data: any) => ipcRenderer.invoke('constructionMaterials:update', data),
  removeConstructionMaterial: (id: number) => ipcRenderer.invoke('constructionMaterials:remove', id),

  // 請求書
  listInvoices: () => ipcRenderer.invoke('invoices:list'),
  createInvoice: (data: any) => ipcRenderer.invoke('invoices:create', data),
  updateInvoice: (data: any) => ipcRenderer.invoke('invoices:update', data),
  deleteInvoice: (id: number) => ipcRenderer.invoke('invoices:delete', id),
  getInvoiceDetail: (id: number) => ipcRenderer.invoke('invoices:getDetail', id),
  getInvoiceByConstruction: (cid: number) => ipcRenderer.invoke('invoices:getByConstruction', cid),
  generatePDF: (data: any) => ipcRenderer.invoke('invoices:generatePDF', data),

  // ダッシュボード
  getDashboardSummary: () => ipcRenderer.invoke('dashboard:summary'),

  // テナント
  listTenants: () => ipcRenderer.invoke('tenants:list'),
  createTenant: (name: string) => ipcRenderer.invoke('tenants:create', name),
  switchTenant: (id: number) => ipcRenderer.invoke('tenants:switch', id),
  deleteTenant: (id: number) => ipcRenderer.invoke('tenants:delete', id),
  currentTenant: () => ipcRenderer.invoke('tenants:current'),

  // ユーザー管理
  listUsers: () => ipcRenderer.invoke('users:list'),
  createUser: (data: any) => ipcRenderer.invoke('users:create', data),
  deleteUser: (id: number) => ipcRenderer.invoke('users:delete', id),

  // 監査ログ
  listAuditLog: () => ipcRenderer.invoke('audit:list'),

  // CSVエクスポート
  exportConstructions: () => ipcRenderer.invoke('export:constructions'),
  exportInvoices: () => ipcRenderer.invoke('export:invoices'),
  exportMaterials: () => ipcRenderer.invoke('export:materials'),

  // バックアップ
  runBackup: () => ipcRenderer.invoke('backup:run'),
  listBackups: () => ipcRenderer.invoke('backup:list'),

  // トンネル
  startTunnel: () => ipcRenderer.invoke('tunnel:start'),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  getLocalIp: () => ipcRenderer.invoke('system:localIp'),

  // 設定
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: any) => ipcRenderer.invoke('config:save', config),
  selectDbPath: () => ipcRenderer.invoke('config:selectDbPath'),
  setDbPath: (folderPath: string) => ipcRenderer.invoke('config:setDbPath', folderPath),

  // 施工複製
  duplicateConstruction: (id: number) => ipcRenderer.invoke('constructions:duplicate', id),
  // 材料CSVインポート
  importMaterialsCSV: () => ipcRenderer.invoke('materials:importCSV'),

  // 見積書PDF
  generateEstimatePDF: (data: any) => ipcRenderer.invoke('estimates:generatePDF', data),

  // 工事写真
  listConstructionPhotos: (cid: number) => ipcRenderer.invoke('constructionPhotos:list', cid),
  addConstructionPhoto: (data: any) => ipcRenderer.invoke('constructionPhotos:add', data),
  deleteConstructionPhoto: (id: number) => ipcRenderer.invoke('constructionPhotos:delete', id),

  // PDF一括出力
  batchExportPDF: () => ipcRenderer.invoke('invoices:batchPDF'),

  // OCR（紙→電子化）
  ocrInvoice: (imageBase64: string) => ipcRenderer.invoke('ai:ocrInvoice', imageBase64),
  importOcrResult: (data: any) => ipcRenderer.invoke('ai:importOcrResult', data),

  // OCR読み取り履歴（過去のPDF保存・コメント＝紐づけ）
  listOcrLog: () => ipcRenderer.invoke('ocrLog:list'),
  getOcrLog: (id: number) => ipcRenderer.invoke('ocrLog:get', id),
  setOcrLogComment: (id: number, comment: string) => ipcRenderer.invoke('ocrLog:setComment', id, comment),
  deleteOcrLog: (id: number) => ipcRenderer.invoke('ocrLog:delete', id),
  openOcrPdf: (id: number) => ipcRenderer.invoke('ocrLog:openPdf', id),

  // クレジット（AIストック）
  getCredits: () => ipcRenderer.invoke('credits:get'),
  getMonthlyUsage: () => ipcRenderer.invoke('credits:usage'),
  addCredits: (amount: number, reason: string) => ipcRenderer.invoke('credits:add', amount, reason),
  getCreditLog: () => ipcRenderer.invoke('credits:log'),

  // プラン管理
  getPlan: () => ipcRenderer.invoke('plan:get'),
  setPlan: (planKey: string, tenantId?: number) => ipcRenderer.invoke('plan:set', planKey, tenantId),
  listPlans: () => ipcRenderer.invoke('plan:list'),
  getCreditCosts: () => ipcRenderer.invoke('plan:costs'),

  // プラン申請
  requestPlan: (planKey: string) => ipcRenderer.invoke('plan:request', planKey),
  listPlanRequests: () => ipcRenderer.invoke('plan:requestList'),
  listAllPlanRequests: () => ipcRenderer.invoke('plan:allRequests'),
  approvePlanRequest: (id: number) => ipcRenderer.invoke('plan:approve', id),
  rejectPlanRequest: (id: number) => ipcRenderer.invoke('plan:reject', id),
  cancelPlanRequest: (id: number) => ipcRenderer.invoke('plan:cancel', id),
  generatePlanInvoice: (id: number) => ipcRenderer.invoke('plan:generateInvoice', id),

  // 見積ログ
  getEstimateLog: () => ipcRenderer.invoke('estimates:log'),
  saveEstimateImage: (data: any) => ipcRenderer.invoke('estimates:saveImage', data),
  deleteEstimateLog: (id: number) => ipcRenderer.invoke('estimates:deleteLog', id),

  // AI
  analyzeImage: (data: any) => ipcRenderer.invoke('ai:analyzeImage', data),
  importDroneCSV: () => ipcRenderer.invoke('drone:importCSV'),
  generateImage: (data: any) => ipcRenderer.invoke('ai:generateImage', data),
  autoCreateFromEstimate: (data: any) => ipcRenderer.invoke('ai:autoCreate', data),

  // データエクスポート/インポート
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  // 作業者
  listWorkers: () => ipcRenderer.invoke('workers:list'),
  createWorker: (data: any) => ipcRenderer.invoke('workers:create', data),
  updateWorker: (data: any) => ipcRenderer.invoke('workers:update', data),
  deleteWorker: (id: number) => ipcRenderer.invoke('workers:delete', id),

  // 出面管理
  listAttendance: (filter: any) => ipcRenderer.invoke('attendance:list', filter),
  createAttendance: (data: any) => ipcRenderer.invoke('attendance:create', data),
  updateAttendance: (data: any) => ipcRenderer.invoke('attendance:update', data),
  deleteAttendance: (id: number) => ipcRenderer.invoke('attendance:delete', id),
  getAttendanceSummary: (filter: any) => ipcRenderer.invoke('attendance:summary', filter),

  // 発注書
  listPurchaseOrders: () => ipcRenderer.invoke('purchaseOrders:list'),
  createPurchaseOrder: (data: any) => ipcRenderer.invoke('purchaseOrders:create', data),
  updatePurchaseOrder: (data: any) => ipcRenderer.invoke('purchaseOrders:update', data),
  deletePurchaseOrder: (id: number) => ipcRenderer.invoke('purchaseOrders:delete', id),
  getPurchaseOrderDetail: (id: number) => ipcRenderer.invoke('purchaseOrders:getDetail', id),
  addPurchaseOrderItem: (data: any) => ipcRenderer.invoke('purchaseOrders:addItem', data),
  updatePurchaseOrderItem: (data: any) => ipcRenderer.invoke('purchaseOrders:updateItem', data),
  deletePurchaseOrderItem: (id: number) => ipcRenderer.invoke('purchaseOrders:deleteItem', id),
  getPOByConstruction: (cid: number) => ipcRenderer.invoke('purchaseOrders:getByConstruction', cid),
  createPOFromConstruction: (cid: number) => ipcRenderer.invoke('purchaseOrders:createFromConstruction', cid),
  generatePurchaseOrderPDF: (data: any) => ipcRenderer.invoke('purchaseOrders:generatePDF', data),

  // AIチャット見積
  aiChat: (data: any) => ipcRenderer.invoke('ai:chat', data),

  // チャットセッション管理
  listChatSessions: () => ipcRenderer.invoke('chatSessions:list'),
  saveChatSession: (data: any) => ipcRenderer.invoke('chatSessions:save', data),
  getChatSession: (id: number) => ipcRenderer.invoke('chatSessions:get', id),
  linkChatSession: (data: any) => ipcRenderer.invoke('chatSessions:link', data),
  deleteChatSession: (id: number) => ipcRenderer.invoke('chatSessions:delete', id),
  getChatSessionsByConstruction: (constructionId: number) => ipcRenderer.invoke('chatSessions:byConstruction', constructionId),

  // 予実管理
  getBudgetSummary: () => ipcRenderer.invoke('budget:summary'),
  updateBudgetActual: (data: any) => ipcRenderer.invoke('budget:updateActual', data),

  // 日報
  listDailyReports: (filter: any) => ipcRenderer.invoke('dailyReports:list', filter),
  createDailyReport: (data: any) => ipcRenderer.invoke('dailyReports:create', data),
  updateDailyReport: (data: any) => ipcRenderer.invoke('dailyReports:update', data),
  deleteDailyReport: (id: number) => ipcRenderer.invoke('dailyReports:delete', id),
  generateDailyReportPDF: (data: any) => ipcRenderer.invoke('dailyReports:generatePDF', data),

  // 工程表
  listGanttTasks: (filter: any) => ipcRenderer.invoke('gantt:list', filter),
  createGanttTask: (data: any) => ipcRenderer.invoke('gantt:create', data),
  updateGanttTask: (data: any) => ipcRenderer.invoke('gantt:update', data),
  deleteGanttTask: (id: number) => ipcRenderer.invoke('gantt:delete', id),

  // 安全書類
  listSafetyWorkers: () => ipcRenderer.invoke('safety:listWorkers'),
  updateSafetyInfo: (data: any) => ipcRenderer.invoke('safety:updateInfo', data),
  listSafetyEducation: (filter: any) => ipcRenderer.invoke('safety:listEducation', filter),
  createSafetyEducation: (data: any) => ipcRenderer.invoke('safety:createEducation', data),
  deleteSafetyEducation: (id: number) => ipcRenderer.invoke('safety:deleteEducation', id),
  listKYRecords: (filter: any) => ipcRenderer.invoke('safety:listKY', filter),
  createKYRecord: (data: any) => ipcRenderer.invoke('safety:createKY', data),
  deleteKYRecord: (id: number) => ipcRenderer.invoke('safety:deleteKY', id),
  generateSafetyPDF: (data: any) => ipcRenderer.invoke('safety:generatePDF', data),

  // 見積比較
  listQuoteComparisons: (cid?: number) => ipcRenderer.invoke('quotes:listComparisons', cid),
  createQuoteComparison: (data: any) => ipcRenderer.invoke('quotes:createComparison', data),
  deleteQuoteComparison: (id: number) => ipcRenderer.invoke('quotes:deleteComparison', id),
  addQuoteVendor: (data: any) => ipcRenderer.invoke('quotes:addVendor', data),
  deleteQuoteVendor: (id: number) => ipcRenderer.invoke('quotes:deleteVendor', id),
  getQuoteComparisonDetail: (id: number) => ipcRenderer.invoke('quotes:getDetail', id),
  generateQuoteComparisonPDF: (data: any) => ipcRenderer.invoke('quotes:generatePDF', data),

  // 写真台帳
  listPhotoLedger: (filter: any) => ipcRenderer.invoke('photoLedger:list', filter),
  addPhotoLedgerEntry: (data: any) => ipcRenderer.invoke('photoLedger:add', data),
  deletePhotoLedgerEntry: (id: number) => ipcRenderer.invoke('photoLedger:delete', id),
  generatePhotoLedgerPDF: (data: any) => ipcRenderer.invoke('photoLedger:generatePDF', data),

  // フィードバック・改善要望
  listFeedback: () => ipcRenderer.invoke('feedback:list'),
  listAllFeedback: () => ipcRenderer.invoke('feedback:listAll'),
  createFeedback: (data: any) => ipcRenderer.invoke('feedback:create', data),
  updateFeedbackStatus: (id: number, status: string, reply?: string) => ipcRenderer.invoke('feedback:updateStatus', id, status, reply),

  // 受注/失注トラッキング
  listOutcomes: () => ipcRenderer.invoke('outcomes:list'),
  createOutcome: (data: any) => ipcRenderer.invoke('outcomes:create', data),
  updateOutcome: (data: any) => ipcRenderer.invoke('outcomes:update', data),
  deleteOutcome: (id: number) => ipcRenderer.invoke('outcomes:delete', id),
  getOutcomeStats: () => ipcRenderer.invoke('outcomes:stats'),
  getSimilarEstimates: (workType: string) => ipcRenderer.invoke('outcomes:similar', workType),

  // 見積共有
  getShareUrl: (logId: number) => ipcRenderer.invoke('estimates:shareUrl', logId),

  // ログイン認証
  login: (username: string, password: string) => ipcRenderer.invoke('auth:login', username, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  resetPassword: (username: string, email: string, newPassword: string) => ipcRenderer.invoke('auth:resetPassword', username, email, newPassword),
  getSession: () => ipcRenderer.invoke('auth:session'),
  isOwnerPC: () => ipcRenderer.invoke('auth:isOwner'),
  setTenantCredits: (tenantId: number, credits: number) => ipcRenderer.invoke('tenants:setCredits', tenantId, credits),
  resetCreditLog: (tenantId: number) => ipcRenderer.invoke('tenants:resetCreditLog', tenantId),
  setTenantUsage: (tenantId: number, used: number) => ipcRenderer.invoke('tenants:setUsage', tenantId, used),
  getTenantUsage: (tenantId: number) => ipcRenderer.invoke('tenants:getUsage', tenantId),
  setTenantActive: (tenantId: number, active: boolean) => ipcRenderer.invoke('tenants:setActive', tenantId, active),
  register: (data: any) => ipcRenderer.invoke('auth:register', data),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // リモート登録申請（Supabase）
  listRemoteRegistrations: () => ipcRenderer.invoke('remote:listRegistrations'),
  approveRemoteRegistration: (companyName: string, plan: string) => ipcRenderer.invoke('remote:approve', companyName, plan),
  rejectRemoteRegistration: (companyName: string) => ipcRenderer.invoke('remote:reject', companyName),
});
