import User from '../models/User.js';
import Payment from '../models/Payment.js';
// Revenue by calendar month, kept per currency: 20 USD and 500 INR are not
// addends, so the rows are never merged into one number.
export async function revenueByMonth() {
  return Payment.aggregate([
    { $match: { status: 'paid' } },
    {
      $group: {
        _id: {
          month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          currency: '$currency',
        },
        revenue: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.month': 1 } },
  ]);
}
export async function registrationsByDay(days = 30) { const since = new Date(Date.now() - days * 864e5); return User.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]); }
export async function usersBy(field) { return User.aggregate([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }]); }
export async function dauMau() {
  const d = new Date(Date.now() - 864e5), m = new Date(Date.now() - 30 * 864e5);
  const [dau, mau] = await Promise.all([User.countDocuments({ lastActiveAt: { $gte: d } }), User.countDocuments({ lastActiveAt: { $gte: m } })]);
  return { dau, mau };
}
export async function paymentSuccessRate() {
  const r = await Payment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const o = Object.fromEntries(r.map(x => [x._id, x.count])); const total = Object.values(o).reduce((a, b) => a + b, 0) || 1;
  return { ...o, total, successRate: ((o.paid || 0) / total) * 100 };
}
