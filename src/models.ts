import mongoose, { Schema, InferSchemaType, model } from 'mongoose';
import { Form } from './types.js';

const Mixed = Schema.Types.Mixed;

// ===== Form stocké tel quel (JSON) =====
const FormSchema = new Schema<Form & { _id: string }>(
    {
        _id: { type: String }, // utilise form.id comme _id
        id: { type: String, required: true },
        title: String,
        description: String,
        live: Mixed,
        participants: [Mixed],
        sections: { type: [Mixed], required: true },
        branchRules: { type: [Mixed], default: [] }
    },
    { timestamps: true, minimize: false }
);
export const FormModel = model('Form', FormSchema);

// ===== Session runtime (position, reveal, lock) =====
const SessionSchema = new Schema(
    {
        formId: { type: String, index: true, required: true, unique: true },
        sectionIndex: { type: Number, default: 0 },
        itemIndex: { type: Number, default: 0 },
        locked: { type: Boolean, default: false },
        revealResults: { type: Boolean, default: false },
        phase: { type: String, enum: ['asking', 'revealing'], default: 'asking' }, // NEW
        startedAt: { type: Date, default: Date.now },
        // Optionnel: horodatage pour compte à rebours
        timerEndsAt: { type: Date, default: null } // NEW
    },
    { timestamps: true }
);
export type SessionDoc = InferSchemaType<typeof SessionSchema>;
export const SessionModel = model('Session', SessionSchema);

// ===== Réponse d’un participant =====
const ResponseSchema = new Schema(
    {
        formId: { type: String, index: true, required: true },
        questionId: { type: String, index: true, required: true },
        participantId: { type: String, index: true, required: true },
        value: {
            choiceIds: [String],
            text: String,
            number: Number
        },
        durationMs: Number, // temps de réponse
        createdAt: { type: Date, default: Date.now }
    },
    { timestamps: true }
);
ResponseSchema.index({ formId: 1, questionId: 1, participantId: 1 }, { unique: true });
export type ResponseDoc = InferSchemaType<typeof ResponseSchema>;
export const ResponseModel = model('Response', ResponseSchema);

// ===== Leaderboard (optionnel simple) =====
const ScoreSchema = new Schema(
    {
        formId: { type: String, index: true, required: true },
        participantId: { type: String, index: true, required: true },
        score: { type: Number, default: 0 }
    },
    { timestamps: true }
);
ScoreSchema.index({ formId: 1, score: -1 });
export const ScoreModel = model('Score', ScoreSchema);

// ===== Connexion =====
export async function connectMongo(uri: string) {
    await mongoose.connect(uri);
    // recommandations de perf
    await FormModel.createCollection().catch(() => { });
    await ResponseModel.createCollection().catch(() => { });
    await SessionModel.createCollection().catch(() => { });
    await ScoreModel.createCollection().catch(() => { });
}
