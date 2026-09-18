import { Router } from 'express';
import { Handler } from './handler';

export function setupRoutes(router: Router, handler: Handler): void {
    router.get('/health', (req, res, next) => handler.health(req, res).catch(next));
    router.post('/db', (req, res, next) => handler.insert(req, res).catch(next));
    router.get('/db/:id', (req, res, next) => handler.get(req, res).catch(next));
    router.put('/db/:id', (req, res, next) => handler.update(req, res).catch(next));
    router.delete('/db/:id', (req, res, next) => handler.delete(req, res).catch(next));
}
