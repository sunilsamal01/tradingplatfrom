import { Router } from 'express';
import * as c from '../controllers/subscriptionController.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { validate } from '../validators/validationMiddleware.js';
import { createSubSchema, changePlanSchema } from '../validators/subscriptionValidator.js';
const r = Router();
r.get('/plans', c.plans);
r.use(authenticate);
r.post('/', validate(createSubSchema), c.create); r.post('/create', validate(createSubSchema), c.create); r.post('/cancel', c.cancel); r.post('/change', validate(changePlanSchema), c.change); r.get('/current', c.current); r.get('/me', c.current);
// Effective plan + benefits for the signed-in user (drives the profile card).
r.get('/entitlements', c.entitlements);
r.get('/usage', c.usage);
r.get('/billing', c.billing);
export default r;