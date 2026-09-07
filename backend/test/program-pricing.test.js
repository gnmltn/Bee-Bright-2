const test = require('node:test');
const assert = require('node:assert/strict');

const Pricing = require('../models/Pricing');
const { getProgramPricingReply, isProgramPricingQuestion } = require('../controllers/aiController');

function stubPricing(rows) {
  const orig = Pricing.find;
  const chain = { sort() { return chain; }, lean() { return Promise.resolve(rows); } };
  Pricing.find = () => chain;
  return () => { Pricing.find = orig; };
}

const ROWS = [
  { programCode: 'TPG101', displayName: 'Toddlers Playgroup – 16 Hours', durationDesc: '16 hours (8 sessions)', priceFull: 2800, priceDown: 1400, displayOrder: 1, active: true },
  { programCode: 'TPG101', displayName: 'Toddlers Playgroup – 40 Hours', durationDesc: '40 hours (20 sessions)', priceFull: 6400, priceDown: 3200, displayOrder: 4, active: true },
  { programCode: 'ACT102', displayName: 'Academic Tutorial – Premier (Elementary)', durationDesc: '12 sessions', priceFull: 2400, priceDown: 1200, displayOrder: 1, active: true },
  { programCode: 'ACT102', displayName: 'Academic Tutorial – Royalty (Elementary)', durationDesc: '60 sessions', priceFull: 11000, priceDown: 5500, displayOrder: 7, active: true },
  { programCode: 'EXP106', displayName: 'Exam Prep – Bright Package', durationDesc: '5 sessions', priceFull: 1250, priceDown: 625, displayOrder: 1, active: true },
];

test('isProgramPricingQuestion: pricing / program-list intents', () => {
  for (const m of [
    'how much is academic tutorial',
    'academic tutorial packages',
    'what programs do you offer',
    'price of toddlers playgroup',
    'examination preparation cost',
    'magkano ang exam prep',
  ]) assert.equal(isProgramPricingQuestion(m), true, m);
  for (const m of ['how do i log in', 'where is my next class', 'reset my password']) {
    assert.equal(isProgramPricingQuestion(m), false, m);
  }
});

test('getProgramPricingReply: specific program → its packages + prices from the DB', async () => {
  const restore = stubPricing(ROWS);
  try {
    const reply = await getProgramPricingReply('how much is Academic Tutorial', 'english');
    assert.match(reply, /Academic Tutorial — ages 2 and up/);
    assert.match(reply, /Premier \(Elementary\).*PHP 2,400 full payment, or PHP 1,200 as the 50% down payment/);
    assert.match(reply, /Royalty \(Elementary\).*PHP 11,000 full payment/);
    assert.match(reply, /GCash, SeaBank, or BDO/);
    assert.doesNotMatch(reply, /Toddlers|Exam Prep/); // only the asked program
  } finally { restore(); }
});

test('getProgramPricingReply: general "what programs" → overview of all three with ranges', async () => {
  const restore = stubPricing(ROWS);
  try {
    const reply = await getProgramPricingReply('what programs do you offer', 'english');
    assert.match(reply, /Bee Bright offers three programs/);
    assert.match(reply, /Toddlers Playgroup \(ages 2 to 4\): 2 packages, PHP 2,800 to PHP 6,400/);
    assert.match(reply, /Academic Tutorial \(ages 2 and up\): 2 packages, PHP 2,400 to PHP 11,000/);
    assert.match(reply, /Examination Preparation \(ages 3 and up\): 1 package, PHP 1,250/);
  } finally { restore(); }
});

test('getProgramPricingReply: empty catalog → null (legacy reply takes over)', async () => {
  const restore = stubPricing([]);
  try {
    assert.equal(await getProgramPricingReply('academic tutorial packages', 'english'), null);
  } finally { restore(); }
});

test('getProgramPricingReply: non-pricing question → null', async () => {
  const restore = stubPricing(ROWS);
  try {
    assert.equal(await getProgramPricingReply('how do i reset my password', 'english'), null);
  } finally { restore(); }
});
