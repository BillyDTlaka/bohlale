export interface BusinessSnapshot {
  business: {
    name: string
    type: string
    periodDays: number
  }
  sales: {
    totalRevenue: number
    totalOrders: number
    avgOrderValue: number
    revenueVsPriorPeriod: number
    topProducts: { name: string; revenue: number; units: number }[]
    slowestProducts: { name: string; revenue: number; units: number }[]
    revenueByWeekday: Record<string, number>
  }
  finance: {
    totalIncome: number
    totalExpenses: number
    netProfit: number
    profitMargin: number
    largestExpenseCategories: { category: string; amount: number }[]
    cashPosition: number
    outstandingReceivables: number
  }
  inventory: {
    totalStockValue: number
    lowStockItems: { name: string; currentStock: number; minStock: number }[]
    outOfStockItems: string[]
    stockTurnoverRate: number
  }
  production: {
    runsCompleted: number
    runsPlanned: number
    avgBatchSize: number
    topRecipeByVolume: string
    wasteRate: number
  }
  customers: {
    totalActiveCustomers: number
    newCustomers: number
    returningCustomerRate: number
    topCustomerSegment: string
    avgDaysBetweenOrders: number
  }
  signals: {
    upcomingLocalEvents: string[]
    seasonalFactors: string[]
    recentFeedbackThemes: string[]
  }
}

export async function buildSnapshot(db: any, periodDays: number): Promise<BusinessSnapshot> {
  const now = new Date()
  const from = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000)
  const priorFrom = new Date(from.getTime() - periodDays * 24 * 60 * 60 * 1000)

  // ── Orders / Sales ──────────────────────────────────────────────────────
  const [orders, priorOrders] = await Promise.all([
    db.order.findMany({
      where: { createdAt: { gte: from }, status: { notIn: ['CANCELLED'] } },
      include: { items: { include: { variant: { include: { product: true } } } } },
    }),
    db.order.findMany({
      where: { createdAt: { gte: priorFrom, lt: from }, status: { notIn: ['CANCELLED'] } },
      select: { total: true },
    }),
  ])

  const totalRevenue   = orders.reduce((s: number, o: any) => s + Number(o.total), 0)
  const priorRevenue   = priorOrders.reduce((s: number, o: any) => s + Number(o.total), 0)
  const revenueVsPrior = priorRevenue > 0 ? ((totalRevenue - priorRevenue) / priorRevenue) * 100 : 0

  // Revenue by weekday
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const revenueByWeekday: Record<string, number> = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 }
  for (const o of orders) {
    const day = dayNames[new Date(o.createdAt).getDay()]
    revenueByWeekday[day] = (revenueByWeekday[day] || 0) + Number(o.total)
  }

  // Product revenue aggregation
  const productRevMap: Record<string, { name: string; revenue: number; units: number }> = {}
  for (const o of orders) {
    for (const item of o.items) {
      const name = item.variant?.product?.name || 'Unknown'
      if (!productRevMap[name]) productRevMap[name] = { name, revenue: 0, units: 0 }
      productRevMap[name].revenue += Number(item.subtotal)
      productRevMap[name].units   += Number(item.quantity)
    }
  }
  const productList = Object.values(productRevMap).sort((a, b) => b.revenue - a.revenue)

  // ── Finance ─────────────────────────────────────────────────────────────
  // Match on either `date` (business date) or `createdAt` — seed data uses createdAt
  const transactions = await db.financeTransaction.findMany({
    where: { OR: [{ date: { gte: from } }, { createdAt: { gte: from } }] },
  })
  const totalIncome   = transactions.filter((t: any) => t.type === 'INCOME').reduce((s: number, t: any) => s + Number(t.amount), 0)
  const totalExpenses = transactions.filter((t: any) => t.type === 'EXPENSE').reduce((s: number, t: any) => s + Number(t.amount), 0)

  const expenseByCategory: Record<string, number> = {}
  for (const t of transactions.filter((t: any) => t.type === 'EXPENSE')) {
    const cat = t.category || 'Other'
    expenseByCategory[cat] = (expenseByCategory[cat] || 0) + Number(t.amount)
  }
  const largestExpenseCategories = Object.entries(expenseByCategory)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)

  // ── Inventory ────────────────────────────────────────────────────────────
  const stockItems = await db.stockItem.findMany({
    include: { uom: { select: { abbreviation: true } } },
  })
  const totalStockValue = stockItems.reduce((s: number, i: any) => s + Number(i.currentStock) * Number(i.costPerUnit), 0)
  const lowStockItems   = stockItems
    .filter((i: any) => i.minStockLevel && Number(i.currentStock) <= Number(i.minStockLevel) && Number(i.currentStock) > 0)
    .map((i: any) => ({ name: i.name, currentStock: Number(i.currentStock), minStock: Number(i.minStockLevel) }))
  const outOfStockItems = stockItems.filter((i: any) => Number(i.currentStock) <= 0).map((i: any) => i.name)

  // Turnover: movements out / avg stock value (simplified)
  const movementsOut = await db.stockMovement.aggregate({
    where: { createdAt: { gte: from }, quantity: { lt: 0 } },
    _sum: { quantity: true },
  })
  const stockTurnoverRate = totalStockValue > 0
    ? Math.abs(Number(movementsOut._sum.quantity || 0)) / (totalStockValue / Number(stockItems.length || 1))
    : 0

  // ── Production ───────────────────────────────────────────────────────────
  const [prodRuns, plannedRuns] = await Promise.all([
    db.productionRun.findMany({
      where: { createdAt: { gte: from }, status: 'COMPLETED' },
      include: { recipe: { select: { name: true } } },
    }),
    db.productionRun.count({ where: { status: { in: ['PLANNED', 'IN_PROGRESS'] } } }),
  ])
  const recipeCount: Record<string, number> = {}
  for (const r of prodRuns) {
    const name = r.recipe?.name || 'Unknown'
    recipeCount[name] = (recipeCount[name] || 0) + 1
  }
  const topRecipeByVolume = Object.entries(recipeCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A'
  const avgBatchSize = prodRuns.length > 0
    ? prodRuns.reduce((s: number, r: any) => s + Number(r.batches || 1), 0) / prodRuns.length
    : 0

  // ── Customers (customers are Users linked via order.customerId) ──────────
  // Unique customers who ordered in this period
  const ordersWithCust = await db.order.findMany({
    where: { createdAt: { gte: from }, status: { notIn: ['CANCELLED'] } },
    select: { customerId: true },
  })
  const allCustIds    = [...new Set(ordersWithCust.map((o: any) => o.customerId))]
  const allCusts      = allCustIds.length

  // New users created in this period who also placed an order
  const newUserIds = await db.user.findMany({
    where: { id: { in: allCustIds }, createdAt: { gte: from } },
    select: { id: true },
  })
  const newCusts = newUserIds.length

  // Returning = had an order before this period AND ordered again in this period
  const returningUsers = await db.user.findMany({
    where: { id: { in: allCustIds }, createdAt: { lt: from } },
    select: { id: true },
  })
  const returningRate = allCusts > 0 ? (returningUsers.length / allCusts) * 100 : 0

  const ambassadorCount = await db.ambassador.count({ where: { status: 'ACTIVE' } })

  return {
    business: { name: 'Tlaka Treats', type: 'bakery', periodDays },
    sales: {
      totalRevenue:          Math.round(totalRevenue * 100) / 100,
      totalOrders:           orders.length,
      avgOrderValue:         orders.length > 0 ? Math.round((totalRevenue / orders.length) * 100) / 100 : 0,
      revenueVsPriorPeriod:  Math.round(revenueVsPrior * 10) / 10,
      topProducts:           productList.slice(0, 5),
      slowestProducts:       productList.slice(-3).reverse(),
      revenueByWeekday,
    },
    finance: {
      totalIncome:   Math.round(totalIncome * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      netProfit:     Math.round((totalIncome - totalExpenses) * 100) / 100,
      profitMargin:  totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 1000) / 10 : 0,
      largestExpenseCategories,
      cashPosition:            0, // extend if cash account tracked separately
      outstandingReceivables:  0,
    },
    inventory: {
      totalStockValue:   Math.round(totalStockValue * 100) / 100,
      lowStockItems:     lowStockItems.slice(0, 10),
      outOfStockItems:   outOfStockItems.slice(0, 10),
      stockTurnoverRate: Math.round(stockTurnoverRate * 10) / 10,
    },
    production: {
      runsCompleted:     prodRuns.length,
      runsPlanned:       plannedRuns,
      avgBatchSize:      Math.round(avgBatchSize * 10) / 10,
      topRecipeByVolume,
      wasteRate:         0, // extend when waste tracking is added
    },
    customers: {
      totalActiveCustomers: allCusts,
      newCustomers:         newCusts,
      returningCustomerRate: Math.round(returningRate * 10) / 10,
      topCustomerSegment:   ambassadorCount > 0 ? 'Ambassadors (resellers)' : 'Direct customers',
      avgDaysBetweenOrders: 0, // complex query — omit for now
    },
    signals: {
      upcomingLocalEvents:   [],
      seasonalFactors:       [],
      recentFeedbackThemes:  [],
    },
  }
}
