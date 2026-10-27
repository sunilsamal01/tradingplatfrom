import assert from 'node:assert/strict';
import test from 'node:test';
import { soleCurrency } from '../services/adminService.js';

// ---------------------------------------------------------------------------
// Admin money was labelled ₹ regardless of what was actually charged, so a $20
// Whop payment read as "₹20". The backend now reports the real currency; these
// pin the rule that keeps a total from being stamped with the wrong symbol.
// ---------------------------------------------------------------------------

test('a single-currency period reports that currency', () => {
  assert.equal(soleCurrency([{ _id: 'USD', amount: 20 }]), 'USD');
  assert.equal(soleCurrency([{ _id: 'INR', amount: 500 }, { _id: 'INR', amount: 250 }]), 'INR');
});

test('a period that mixes currencies reports none, because the sum is meaningless', () => {
  // 20 USD + 500 INR is not 520 of anything.
  assert.equal(soleCurrency([{ _id: 'USD', amount: 20 }, { _id: 'INR', amount: 500 }]), null);
});

test('no revenue falls back to USD rather than inventing rupees', () => {
  assert.equal(soleCurrency([]), 'USD');
  assert.equal(soleCurrency(undefined), 'USD');
  assert.equal(soleCurrency([{ _id: null, amount: 0 }]), 'USD');
});

test('the live payment currency wins over the model default', () => {
  // Payment.currency defaults to INR, so a USD payment must carry USD explicitly
  // — anything else would silently relabel real dollars.
  assert.equal(soleCurrency([{ _id: 'USD', amount: 20 }, { _id: null, amount: 0 }]), 'USD');
});
