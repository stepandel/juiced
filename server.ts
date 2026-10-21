import { Hono } from 'hono';
import { website } from './service/src/website.js';

const app = new Hono();
app.route('/', website());
export default app;
