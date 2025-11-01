import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';

import { connectMongo, FormModel, SessionModel, ResponseModel, ScoreModel } from './models.js';
import { aggregateResults } from './services/results.js';
import type { ClientToServerEvents, ServerToClientEvents, LiveState, Form } from './types.js';

const PORT = Number(process.env.PORT || 8080);
const ORIGIN = process.env.CORS_ORIGIN || '*';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/liveforms';

await connectMongo(MONGO_URI);

// ----- Express (REST minimal) -----
const app = express();
app.use(helmet());
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Create/Upsert a Form
app.post('/forms', async (req, res) => {
    try {
        const form: Form = req.body;
        if (!form?.id) return res.status(400).json({ error: 'id is required' });
        await FormModel.findByIdAndUpdate(form.id, { ...form, _id: form.id }, { upsert: true });
        // Init session if absent
        const hasSession = await SessionModel.findOne({ formId: form.id });
        if (!hasSession) {
            await SessionModel.create({ formId: form.id, sectionIndex: 0, itemIndex: 0, locked: false, revealResults: false });
        }
        res.json({ ok: true, id: form.id });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Read a Form
app.get('/forms/:id', async (req, res) => {
    const form = await FormModel.findById(req.params.id);
    if (!form) return res.status(404).json({ error: 'not_found' });
    res.json(form);
});

const httpServer = createServer(app);

// ----- Socket.IO -----
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: ORIGIN, credentials: true }
});

// Utilitaires

function room(formId: string) {
    return `form:${formId}`;
}
function adminRoom(formId: string) {
    return `form:${formId}:admins`;
}

async function getState(formId: string): Promise<LiveState> {
    const s = await SessionModel.findOne({ formId });
    if (!s) throw new Error('session_not_found');
    const now = Date.now();
    const remaining =
        s.timerEndsAt ? Math.max(0, Math.floor((new Date(s.timerEndsAt).getTime() - now) / 1000)) : undefined;
    return {
        formId,
        sectionIndex: s.sectionIndex,
        itemIndex: s.itemIndex,
        locked: s.locked,
        revealResults: s.revealResults,
        phase: (s.phase as any) || 'asking',
        timer: s.timerEndsAt ? { remaining, total: undefined } : null
    };
}

async function getCurrentQuestion(formId: string) {
    const form = await FormModel.findById(formId).lean();
    const s = await SessionModel.findOne({ formId }).lean();
    if (!form || !s) return { question: null, sectionIndex: 0, itemIndex: 0 };

    const section = form.sections?.[s.sectionIndex];
    const question = section?.items?.[s.itemIndex] || null;
    return { question, sectionIndex: s.sectionIndex, itemIndex: s.itemIndex, form };
}

async function emitAdminDashboard(formId: string) {
    const { question, sectionIndex, itemIndex } = await getCurrentQuestion(formId);
    let aggregates: any = null;
    if (question) {
        aggregates = await aggregateResults(formId, question.id);
    }
    io.to(adminRoom(formId)).emit('admin:dashboard', {
        formId, sectionIndex, itemIndex, question, aggregates
    });
}

function isAdmin(role: 'admin' | 'viewer', suppliedHostCode?: string, form?: Form) {
    if (role !== 'admin') return false;
    const expected = form?.live?.hostSessionCode;
    if (!expected) return true; // si pas configuré : admin libre
    return suppliedHostCode === expected;
}

async function advanceToNextQuestion(formId: string, form?: any) {
    const formDoc = form || (await FormModel.findById(formId).lean());
    if (!formDoc) return;

    const s = await SessionModel.findOne({ formId });
    if (!s) return;

    let sec = s.sectionIndex;
    let item = s.itemIndex + 1;
    const sections = formDoc.sections || [];
    if (sec >= sections.length) return;
    const curSection = sections[sec];

    if (item >= (curSection?.items?.length || 0)) {
        sec += 1;
        item = 0;
    }
    const atEnd = sec >= sections.length;

    if (atEnd) {
        // fin du form
        await SessionModel.updateOne(
            { formId },
            { $set: { revealResults: true, locked: true, phase: 'revealing', timerEndsAt: null } }
        );
    } else {
        // nouvelle question: déverrouillé, phase 'asking'
        await SessionModel.updateOne(
            { formId },
            { $set: { sectionIndex: sec, itemIndex: item, revealResults: false, locked: false, phase: 'asking', timerEndsAt: null } }
        );
    }

    io.to(room(formId)).emit('state', await getState(formId));
    await emitAdminDashboard(formId);
}

// Socket handlers

io.on('connection', (socket) => {
    // JOIN
    socket.on('join_form', async ({ formId, role, sessionCode, hostSessionCode }) => {
        try {
            const formDoc = await FormModel.findById(formId);
            if (!formDoc) return socket.emit('error_msg', { code: 'form_not_found', message: 'Form introuvable' });

            const form = formDoc.toObject() as Form;
            const live = form.live ?? { enabled: false };

            // contrôle basique sessionCode pour viewers
            if (role === 'viewer' && live.enabled && live.sessionCode && sessionCode !== live.sessionCode) {
                return socket.emit('error_msg', { code: 'bad_session_code', message: 'Code de session invalide' });
            }

            // contrôle host code pour admin
            if (!isAdmin(role, hostSessionCode, form)) {
                return socket.emit('error_msg', { code: 'unauthorized', message: 'Accès admin refusé' });
            }

            // rejoindre la room du formulaire
            socket.join(room(formId));

            // envoyer l’état courant
            if (role === 'admin' && isAdmin(role, hostSessionCode, form)) {
                socket.join(adminRoom(formId));         // <<< NEW
                await emitAdminDashboard(formId);       // <<< envoie question + résultats à l’admin
            }

            const state = await getState(formId);
            socket.emit('state', state);
        } catch (e: any) {
            socket.emit('error_msg', { code: 'join_error', message: e.message });
        }
    });

    // État
    socket.on('get_state', async ({ formId }) => {
        try {
            const state = await getState(formId);
            socket.emit('state', state);
        } catch (e: any) {
            socket.emit('error_msg', { code: 'state_error', message: e.message });
        }
    });

    // Soumission de réponse
    socket.on('submit_answer', async ({ formId, questionId, value }) => {
        try {
            const s = await SessionModel.findOne({ formId });
            if (!s) return socket.emit('error_msg', { code: 'session_not_found', message: 'Session absente' });
            if (s.locked) return socket.emit('error_msg', { code: 'locked', message: 'Question verrouillée' });

            // participantId depuis handshake auth (ou généré côté client et passé ici)
            const participantId = (socket.handshake.auth?.participantId as string) || 'anon:' + socket.id;

            await ResponseModel.findOneAndUpdate(
                { formId, questionId, participantId },
                { $set: { value, createdAt: new Date() } },
                { upsert: true }
            );

            // si reveal actif => renvoyer les résultats agrégés en live
            if (s.revealResults) {
                const aggregates = await aggregateResults(formId, questionId);
                io.to(room(formId)).emit('results', { questionId, aggregates });
            }

            const form = await FormModel.findById(formId).lean();
            if (form && s) {
                const section = form.sections![s.sectionIndex];
                const q = section?.items[s.itemIndex];
                if (q && q.id === questionId) {
                    const aggregates = await aggregateResults(formId, questionId);
                    io.to(adminRoom(formId)).emit('admin:results', { questionId, aggregates }); // <<< NEW
                }
            }
        } catch (e: any) {
            socket.emit('error_msg', { code: 'submit_error', message: e.message });
        }
    });

    // --------- ADMIN CONTROLS ---------

    socket.on('admin:set_question', async ({ formId, sectionIndex, itemIndex }) => {
        await SessionModel.findOneAndUpdate(
            { formId },
            { $set: { sectionIndex, itemIndex, revealResults: false, locked: false, phase: 'asking', timerEndsAt: null } },
            { new: true, upsert: true }
        );
        io.to(room(formId)).emit('state', await getState(formId));
    });

    socket.on('admin:start_question', async ({ formId }) => {
        const form = await FormModel.findById(formId).lean();
        const s = await SessionModel.findOne({ formId });
        if (!form || !s) return;

        const question = form.sections![s.sectionIndex]?.items[s.itemIndex];
        let endsAt: Date | null = null;

        if (question?.duration?.type === 'timer' && typeof question.duration.duration === 'number') {
            endsAt = new Date(Date.now() + question.duration.duration * 1000);
        }

        await SessionModel.updateOne(
            { formId },
            { $set: { locked: false, revealResults: false, phase: 'asking', timerEndsAt: endsAt } }
        );

        io.to(room(formId)).emit('state', await getState(formId));
    });

    socket.on('admin:next', async ({ formId }) => {
        await advanceToNextQuestion(formId);
    });

    socket.on('admin:reveal', async ({ formId, show }) => {
        const s = await SessionModel.findOneAndUpdate(
            { formId },
            { $set: { revealResults: show, locked: true, phase: show ? 'revealing' : 'asking', timerEndsAt: null } },
            { new: true }
        );
        if (!s) return;

        const form = await FormModel.findById(formId).lean();
        if (!form) return;

        const section = form.sections![s.sectionIndex];
        const question = section?.items[s.itemIndex];
        if (!question) return;

        // agrégats
        const aggregates = await aggregateResults(formId, question.id);
        io.to(room(formId)).emit('state', await getState(formId));
        io.to(room(formId)).emit('results', { questionId: question.id, aggregates });
        await emitAdminDashboard(formId);

        // avance auto
        const wait = show ? (form.live?.autoAdvanceAfterRevealSec ?? form.live?.interQuestionCountdownSec ?? 0) : 0;
        if (show && wait > 0) {
            setTimeout(() => advanceToNextQuestion(formId, form).catch(() => { }), wait * 1000);
        }
    });

    socket.on('admin:lock', async ({ formId, locked }) => {
        await SessionModel.updateOne({ formId }, { $set: { locked } });
        io.to(room(formId)).emit('state', await getState(formId));
    });

});

httpServer.listen(PORT, () => {
    console.log(`✅ Live server on http://localhost:${PORT}`);
});
