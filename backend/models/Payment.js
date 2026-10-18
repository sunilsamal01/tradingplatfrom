import mongoose from 'mongoose';
const s = new mongoose.Schema({
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
  provider:{type:String,enum:['razorpay','stripe','whop'],required:true},
  providerOrderId:String,
  providerPaymentId:String,
  // `amount` is the legacy MAJOR-unit figure (rupees/dollars) kept for existing
  // reports and receipts. `amountCents` is the authoritative INTEGER minor-unit
  // value used for provider reconciliation — always prefer it for money maths.
  amount:{type:Number,required:true},
  amountCents:{type:Number,min:0,validate:{validator:Number.isInteger,message:'amountCents must be an integer'}},
  currency:{type:String,default:'INR',uppercase:true},
  plan:String,
  // Set when this Payment was raised by the unified checkout. Lets /payments/verify
  // and the webhook settle the linked CheckoutOrder idempotently, and tells them
  // to SKIP the legacy plan-activation path (the CheckoutOrder owns fulfilment).
  checkoutOrderId:{type:mongoose.Schema.Types.ObjectId,ref:'CheckoutOrder',index:true,sparse:true},
  status:{type:String,enum:['created','paid','failed','refunded'],default:'created',index:true},
  webhookEventId:{type:String,unique:true,sparse:true}
},{timestamps:true});
// Webhook + order lookups during checkout verification and reconciliation.
s.index({ providerOrderId:1 });
s.index({ userId:1, createdAt:-1 });
// Admin revenue/transaction analytics filter status within a date range
// (see adminService.overview/listPayments). Matches that query shape.
s.index({ status:1, createdAt:-1 });
export default mongoose.model('Payment', s);
