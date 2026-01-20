import { Router } from 'express';
import { Handler } from './handler';

export function setupRoutes(router: Router, handler: Handler): void {
    router.post('/db', (req, res) => handler.insert(req, res));
    router.get('/db/:id', (req, res) => handler.get(req, res));
    router.put('/db/:id', (req, res) => handler.update(req, res));
}
