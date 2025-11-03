import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';

import { connectMongo, FormModel, SessionModel, ResponseModel } from './models.js';
import type { SessionDoc } from './models.js';
import { aggregateResults } from './services/results.js';
import { generateResultsInterpretation } from './services/ai.js';
import type { AggregatedResults } from './services/results.js';
import type { ClientToServerEvents, ServerToClientEvents, LiveState, Form } from './types.js';

const PORT = Number(process.env.PORT || 8080);
const rawOrigins = process.env.CORS_ORIGIN
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const allowAllOrigins = !rawOrigins || rawOrigins.includes('*');
const allowedOrigins = allowAllOrigins ? [] : rawOrigins ?? [];
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/liveforms';

await connectMongo(MONGO_URI);

// const corsOptions: cors.CorsOptions = allowAllOrigins
//     ? { origin: true, credentials: true }
//     : {
//           origin: (origin, callback) => {
//               if (!origin) {
//                   callback(null, true);
//                   return;
//               }
//               if (allowedOrigins.includes(origin)) {
//                   callback(null, true);
//                   return;
//               }
//               callback(new Error('Not allowed by CORS'));
//           },
//           credentials: true
//       };

const corsOptions: cors.CorsOptions = {
  origin: (_origin, cb) => cb(null, true),
  credentials: true,
};

const app = express();
app.use(helmet());
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

app.post('/forms', async (req, res) => {
    try {
        const form: Form = req.body;
        if (!form?.id) {
            res.status(400).json({ error: 'id is required' });
            return;
        }

        await FormModel.findByIdAndUpdate(form.id, { ...form, _id: form.id }, { upsert: true });
        await SessionModel.findOneAndUpdate(
            { formId: form.id },
            {
                $setOnInsert: {
                    formId: form.id,
                    sectionIndex: 0,
                    itemIndex: 0,
                    locked: false,
                    revealResults: false,
                    phase: 'asking',
                    timerEndsAt: null
                }
            },
            { upsert: true }
        );

        res.json({ ok: true, id: form.id });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.get('/forms/:id', async (req, res) => {
    const form = await FormModel.findById(req.params.id);
    if (!form) {
        res.status(404).json({ error: 'not_found' });
        return;
    }
    res.json(form);
});

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: allowAllOrigins
        ? { origin: true, credentials: true }
        : { origin: allowedOrigins, credentials: true }
});

type FormDocument = Form & { _id: string };
type DashboardContext = { questionId?: string; aggregates?: AggregatedResults | null };

type ParticipantResultSubscription = { formId: string; questionId: string };

const participantResultSubscriptions = new Map<string, Map<string, Set<string>>>();
const socketResultSubscriptions = new Map<string, ParticipantResultSubscription>();
const formViewerSockets = new Map<string, Set<string>>();
const socketParticipation = new Map<string, { formId: string; role: 'admin' | 'viewer' }>();

function room(formId: string) {
    return `form:${formId}`;
}

function adminRoom(formId: string) {
    return `form:${formId}:admins`;
}

async function fetchForm(formId: string): Promise<FormDocument | null> {
    return FormModel.findById(formId).lean<FormDocument>().exec();
}

async function fetchSession(formId: string): Promise<SessionDoc | null> {
    return SessionModel.findOne({ formId }).lean<SessionDoc>().exec();
}

function removeSocketSubscription(socketId: string) {
    const existing = socketResultSubscriptions.get(socketId);
    if (!existing) {
        return;
    }

    const formSubscriptions = participantResultSubscriptions.get(existing.formId);
    if (formSubscriptions) {
        const questionSubscriptions = formSubscriptions.get(existing.questionId);
        if (questionSubscriptions) {
            questionSubscriptions.delete(socketId);
            if (questionSubscriptions.size === 0) {
                formSubscriptions.delete(existing.questionId);
            }
        }
        if (formSubscriptions.size === 0) {
            participantResultSubscriptions.delete(existing.formId);
        }
    }

    socketResultSubscriptions.delete(socketId);
}

function emitParticipantsCount(formId: string) {
    const count = formViewerSockets.get(formId)?.size ?? 0;
    io.to(room(formId)).emit('participants_count', { count });
    io.to(adminRoom(formId)).emit('participants_count', { count });
}

function removeSocketParticipation(socketId: string) {
    const existing = socketParticipation.get(socketId);
    if (!existing) {
        return;
    }

    socketParticipation.delete(socketId);

    if (existing.role !== 'viewer') {
        return;
    }

    const viewers = formViewerSockets.get(existing.formId);
    if (!viewers) {
        return;
    }

    viewers.delete(socketId);
    if (viewers.size === 0) {
        formViewerSockets.delete(existing.formId);
    }

    emitParticipantsCount(existing.formId);
}

function setSocketParticipation(socketId: string, formId: string, role: 'admin' | 'viewer') {
    const existing = socketParticipation.get(socketId);
    if (existing?.formId === formId && existing.role === role) {
        return;
    }

    removeSocketParticipation(socketId);

    socketParticipation.set(socketId, { formId, role });

    if (role !== 'viewer') {
        emitParticipantsCount(formId);
        return;
    }

    let viewers = formViewerSockets.get(formId);
    if (!viewers) {
        viewers = new Set();
        formViewerSockets.set(formId, viewers);
    }

    viewers.add(socketId);
    emitParticipantsCount(formId);
}

function subscribeParticipantToResults(socketId: string, formId: string, questionId: string) {
    const existing = socketResultSubscriptions.get(socketId);
    if (existing?.formId === formId && existing?.questionId === questionId) {
        return;
    }

    removeSocketSubscription(socketId);

    let formSubscriptions = participantResultSubscriptions.get(formId);
    if (!formSubscriptions) {
        formSubscriptions = new Map();
        participantResultSubscriptions.set(formId, formSubscriptions);
    }

    let questionSubscriptions = formSubscriptions.get(questionId);
    if (!questionSubscriptions) {
        questionSubscriptions = new Set();
        formSubscriptions.set(questionId, questionSubscriptions);
    }

    questionSubscriptions.add(socketId);
    socketResultSubscriptions.set(socketId, { formId, questionId });
}

function clearFormSubscriptions(formId: string) {
    const formSubscriptions = participantResultSubscriptions.get(formId);
    if (!formSubscriptions) {
        return;
    }

    for (const socketIds of formSubscriptions.values()) {
        for (const socketId of socketIds) {
            const subscription = socketResultSubscriptions.get(socketId);
            if (subscription?.formId === formId) {
                socketResultSubscriptions.delete(socketId);
            }
        }
    }

    participantResultSubscriptions.delete(formId);
}

function getSubscriberSockets(formId: string, questionId: string): Set<string> | undefined {
    return participantResultSubscriptions.get(formId)?.get(questionId);
}

async function getState(formId: string): Promise<LiveState> {
    const session = await fetchSession(formId);
    if (!session) {
        throw new Error('session_not_found');
    }

    const remaining = session.timerEndsAt
        ? Math.max(0, Math.floor((session.timerEndsAt.getTime() - Date.now()) / 1000))
        : undefined;

    return {
        formId,
        sectionIndex: session.sectionIndex,
        itemIndex: session.itemIndex,
        locked: session.locked,
        revealResults: session.revealResults,
        phase: session.phase ?? 'asking',
        timer: session.timerEndsAt ? { remaining, total: undefined } : null
    };
}

async function broadcastState(formId: string): Promise<LiveState> {
    const state = await getState(formId);
    io.to(room(formId)).emit('state', state);
    return state;
}

async function broadcastStateAndDashboard(formId: string) {
    await Promise.all([broadcastState(formId), emitAdminDashboard(formId)]);
}

async function getCurrentQuestion(formId: string, session?: SessionDoc | null) {
    const currentSession = session ?? (await fetchSession(formId));
    if (!currentSession) {
        return { question: null, sectionIndex: 0, itemIndex: 0 };
    }

    const form = await fetchForm(formId);
    if (!form) {
        return { question: null, sectionIndex: currentSession.sectionIndex, itemIndex: currentSession.itemIndex };
    }

    const section = form.sections?.[currentSession.sectionIndex];
    const question = section?.items?.[currentSession.itemIndex] ?? null;

    return { question, sectionIndex: currentSession.sectionIndex, itemIndex: currentSession.itemIndex };
}

async function emitAdminDashboard(
    formId: string,
    context: DashboardContext = {}
): Promise<{ questionId: string | null; aggregates: AggregatedResults | null }> {
    const session = await fetchSession(formId);
    const { question, sectionIndex, itemIndex } = await getCurrentQuestion(formId, session);
    const shouldReuseAggregates = Boolean(
        question && context.questionId === question.id && context.aggregates !== undefined
    );
    const aggregates = question
        ? shouldReuseAggregates
            ? context.aggregates ?? null
            : await aggregateResults(formId, question.id)
        : null;

    io.to(adminRoom(formId)).emit('admin:dashboard', {
        formId,
        sectionIndex,
        itemIndex,
        question,
        aggregates
    });

    return { questionId: question?.id ?? null, aggregates };
}

async function emitAggregates(
    formId: string,
    questionId: string,
    destinations: { includeRoom?: boolean; includeAdmin?: boolean },
    precomputedAggregates?: AggregatedResults | null
) {
    const subscribers = getSubscriberSockets(formId, questionId);
    const hasSubscribers = Boolean(subscribers && subscribers.size > 0);
    const needsAggregates =
        destinations.includeRoom || destinations.includeAdmin || hasSubscribers || precomputedAggregates !== undefined;
    if (!needsAggregates) {
        return;
    }

    const aggregates =
        precomputedAggregates !== undefined ? precomputedAggregates ?? null : await aggregateResults(formId, questionId);

    if (!aggregates) {
        return;
    }

    const resultPayload = { questionId, aggregates };

    if (hasSubscribers && subscribers) {
        for (const socketId of subscribers) {
            io.to(socketId).emit('results', resultPayload);
        }
    }

    if (destinations.includeRoom) {
        io.to(room(formId)).emit('results', resultPayload);
    }

    if (destinations.includeAdmin) {
        io.to(adminRoom(formId)).emit('admin:results', { questionId, aggregates });
        await emitAdminDashboard(formId, { questionId, aggregates });
    }
}

function isAdmin(role: 'admin' | 'viewer', suppliedHostCode: string | undefined, form: Form | null) {
    if (role !== 'admin') {
        return false;
    }
    const expected = form?.live?.hostSessionCode;
    if (!expected) {
        return true;
    }
    return suppliedHostCode === expected;
}

async function advanceToNextQuestion(formId: string, form?: FormDocument | null) {
    const formDoc = form ?? (await fetchForm(formId));
    if (!formDoc) {
        return;
    }

    const session = await fetchSession(formId);
    if (!session) {
        return;
    }

    const sections = formDoc.sections ?? [];
    if (session.sectionIndex >= sections.length) {
        return;
    }

    let sectionIndex = session.sectionIndex;
    let itemIndex = session.itemIndex + 1;
    const currentSection = sections[sectionIndex];

    if (itemIndex >= (currentSection?.items?.length ?? 0)) {
        sectionIndex += 1;
        itemIndex = 0;
    }

    const reachedEnd = sectionIndex >= sections.length;

    if (reachedEnd) {
        await SessionModel.updateOne(
            { formId },
            { $set: { revealResults: true, locked: true, phase: 'revealing', timerEndsAt: null } }
        );
    } else {
        await SessionModel.updateOne(
            { formId },
            {
                $set: {
                    sectionIndex,
                    itemIndex,
                    revealResults: false,
                    locked: false,
                    phase: 'asking',
                    timerEndsAt: null
                }
            }
        );
    }

    clearFormSubscriptions(formId);
    await broadcastStateAndDashboard(formId);
}

io.on('connection', (socket) => {
    socket.on('join_form', async ({ formId, role, sessionCode, hostSessionCode }) => {
        try {
            const formDoc = await fetchForm(formId);
            if (!formDoc) {
                socket.emit('error_msg', { code: 'form_not_found', message: 'Form introuvable' });
                return;
            }

            const live = formDoc.live ?? { enabled: false };
            if (
                role === 'viewer' &&
                live.enabled &&
                live.sessionCode &&
                sessionCode !== live.sessionCode
            ) {
                socket.emit('error_msg', { code: 'bad_session_code', message: 'Code de session invalide' });
                return;
            }

            const hasAdminAccess = isAdmin(role, hostSessionCode, formDoc);
            if (role === 'admin' && !hasAdminAccess) {
                socket.emit('error_msg', { code: 'unauthorized', message: 'Accès admin refusé' });
                return;
            }

            removeSocketSubscription(socket.id);
            socket.join(room(formId));

            setSocketParticipation(socket.id, formId, role);

            if (role === 'admin' && hasAdminAccess) {
                socket.join(adminRoom(formId));
                emitParticipantsCount(formId);
                const dashboard = await emitAdminDashboard(formId);
                if (dashboard.questionId && dashboard.aggregates) {
                    socket.emit('admin:results', {
                        questionId: dashboard.questionId,
                        aggregates: dashboard.aggregates
                    });
                }
            }

            const state = await getState(formId);
            socket.emit('state', state);
        } catch (error) {
            socket.emit('error_msg', { code: 'join_error', message: (error as Error).message });
        }
    });

    socket.on('get_state', async ({ formId }) => {
        try {
            const state = await getState(formId);
            socket.emit('state', state);
        } catch (error) {
            socket.emit('error_msg', { code: 'state_error', message: (error as Error).message });
        }
    });

    socket.on('submit_answer', async ({ formId, questionId, value }) => {
        try {
            const session = await fetchSession(formId);
            if (!session) {
                socket.emit('error_msg', { code: 'session_not_found', message: 'Session absente' });
                return;
            }

            if (session.locked) {
                socket.emit('error_msg', { code: 'locked', message: 'Question verrouillée' });
                return;
            }

            const currentQuestion = await getCurrentQuestion(formId, session);
            if (currentQuestion.question?.id !== questionId) {
                socket.emit('error_msg', { code: 'not_current_question', message: 'Question non active' });
                return;
            }

            const participantAuth = socket.handshake.auth?.participantId;
            const participantId =
                typeof participantAuth === 'string' && participantAuth.length > 0
                    ? participantAuth
                    : `anon:${socket.id}`;

            await ResponseModel.findOneAndUpdate(
                { formId, questionId, participantId },
                { $set: { value, createdAt: new Date() } },
                { upsert: true }
            );

            subscribeParticipantToResults(socket.id, formId, questionId);

            await emitAggregates(
                formId,
                questionId,
                {
                    includeRoom: session.revealResults,
                    includeAdmin: true
                }
            );
        } catch (error) {
            socket.emit('error_msg', { code: 'submit_error', message: (error as Error).message });
        }
    });

    socket.on('admin:set_question', async ({ formId, sectionIndex, itemIndex }) => {
        await SessionModel.findOneAndUpdate(
            { formId },
            {
                $set: {
                    sectionIndex,
                    itemIndex,
                    revealResults: false,
                    locked: false,
                    phase: 'asking',
                    timerEndsAt: null
                }
            },
            { new: true, upsert: true }
        );
        clearFormSubscriptions(formId);
        await broadcastStateAndDashboard(formId);
    });

    socket.on('admin:reset_form', async ({ formId }) => {
        await Promise.all([
            SessionModel.findOneAndUpdate(
                { formId },
                {
                    $set: {
                        sectionIndex: 0,
                        itemIndex: 0,
                        revealResults: false,
                        locked: false,
                        phase: 'asking',
                        timerEndsAt: null
                    }
                },
                { new: true, upsert: true }
            ),
            ResponseModel.deleteMany({ formId })
        ]);
        clearFormSubscriptions(formId);
        await broadcastStateAndDashboard(formId);
    });

    socket.on('admin:start_question', async ({ formId }) => {
        const [formDoc, session] = await Promise.all([fetchForm(formId), fetchSession(formId)]);
        if (!formDoc || !session) {
            return;
        }

        const question = formDoc.sections?.[session.sectionIndex]?.items?.[session.itemIndex];
        let endsAt: Date | null = null;

        if (question?.duration?.type === 'timer' && typeof question.duration.duration === 'number') {
            endsAt = new Date(Date.now() + question.duration.duration * 1000);
        }

        await SessionModel.updateOne(
            { formId },
            { $set: { locked: false, revealResults: false, phase: 'asking', timerEndsAt: endsAt } }
        );

        await broadcastStateAndDashboard(formId);
    });

    socket.on('admin:next', async ({ formId }) => {
        await advanceToNextQuestion(formId);
    });

    socket.on('admin:reveal', async ({ formId, show }) => {
        const session = await SessionModel.findOneAndUpdate(
            { formId },
            { $set: { revealResults: show, locked: true, phase: show ? 'revealing' : 'asking', timerEndsAt: null } },
            { new: true }
        )
            .lean<SessionDoc>()
            .exec();
        if (!session) {
            return;
        }

        const formDoc = await fetchForm(formId);
        if (!formDoc) {
            return;
        }

        const section = formDoc.sections?.[session.sectionIndex];
        const question = section?.items?.[session.itemIndex];
        if (!question) {
            return;
        }

        await broadcastState(formId);
        await emitAggregates(formId, question.id, { includeRoom: true, includeAdmin: true });

        const wait = show
            ? formDoc.live?.autoAdvanceAfterRevealSec ?? formDoc.live?.interQuestionCountdownSec ?? 0
            : 0;
        if (show && wait > 0) {
            setTimeout(() => {
                void advanceToNextQuestion(formId, formDoc);
            }, wait * 1000);
        }
    });

    socket.on('admin:lock', async ({ formId, locked }) => {
        await SessionModel.updateOne({ formId }, { $set: { locked } });
        await broadcastState(formId);

        if (!locked) {
            return;
        }

        const [formDoc, session] = await Promise.all([fetchForm(formId), fetchSession(formId)]);
        if (!formDoc || !session) {
            return;
        }

        const section = formDoc.sections?.[session.sectionIndex];
        const question = section?.items?.[session.itemIndex];
        if (
            !question?.id ||
            !question.reveal?.explanation?.showExplanation ||
            !question.reveal?.explanation?.explanationAi
        ) {
            return;
        }

        try {
            const aggregates = await aggregateResults(formId, question.id);
            const interpretation = await generateResultsInterpretation({
                question,
                aggregates
            });

            if (interpretation) {
                io.to(adminRoom(formId)).emit('admin:explanation', {
                    questionId: question.id,
                    explanation: interpretation
                });
            }

            io.to(adminRoom(formId)).emit('admin:results', {
                questionId: question.id,
                aggregates,
                interpretation: interpretation ?? null
            });
        } catch (error) {
            console.error('Failed to generate AI explanation on lock', error);
        }
    });

    socket.on('disconnect', () => {
        removeSocketSubscription(socket.id);
        removeSocketParticipation(socket.id);
    });
});

httpServer.listen(PORT, () => {
    console.log(`✅ Live server on http://localhost:${PORT}`);
});
