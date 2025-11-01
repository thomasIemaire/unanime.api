import { io } from "socket.io-client";

const serverUrl = process.env.SERVER_URL ?? "http://localhost:8080";
const formId = process.env.FORM_ID ?? "ia_sondage_live_001";
const sessionCode = process.env.SESSION_CODE ?? 'IA2025';
const participantId = process.env.PARTICIPANT_ID ?? `participant-${Math.random().toString(36).slice(2, 8)}`;
const displayName = process.env.DISPLAY_NAME ?? "Participant Bot";

const form = await loadForm();
if (!form) {
    console.error(`Unable to load form ${formId} from ${serverUrl}`);
    process.exit(1);
}

const socket = io(serverUrl, {
    transports: ["websocket"],
    auth: { participantId }
});

let lastAnsweredQuestionId = null;

socket.on("connect", () => {
    console.log("✅ connected:", socket.id);
    socket.emit("join_form", {
        formId,
        role: "viewer",
        sessionCode,
        participantId,
        displayName
    });
});

socket.on("state", (state) => {
    console.log("🛰️  state", JSON.stringify(state, null, 2));
    handleState(state).catch((error) => console.error("Failed to handle state", error));
});

socket.on("results", (payload) => {
    console.log("📊 room results", JSON.stringify(payload, null, 2));
});

socket.on("error_msg", (error) => {
    console.error("❌ error", error);
});

socket.on("disconnect", (reason) => {
    console.log("🔌 disconnected:", reason);
});

socket.on("connect_error", (error) => {
    console.error("⚠️  connection error", error.message);
});

process.on("SIGINT", () => {
    console.log("Received SIGINT, closing connection...");
    socket.disconnect();
    process.exit(0);
});

async function handleState(state) {
    if (state.locked) {
        return;
    }

    const question = getQuestion(state.sectionIndex, state.itemIndex);
    if (!question) {
        console.warn("No question available for state", state);
        return;
    }

    if (question.id === lastAnsweredQuestionId) {
        return;
    }

    const value = buildAnswer(question);
    if (!value) {
        console.warn("Unable to build an answer for question", question.id);
        return;
    }

    console.log("📝 submitting answer", { questionId: question.id, value });
    socket.emit("submit_answer", { formId, questionId: question.id, value });
    lastAnsweredQuestionId = question.id;
}

function getQuestion(sectionIndex, itemIndex) {
    const section = form.sections?.[sectionIndex];
    return section?.items?.[itemIndex] ?? null;
}

function buildAnswer(question) {
    const [firstChoice] = question.choices ?? [];
    if (!firstChoice) {
        return null;
    }

    if (firstChoice.input === "text") {
        return { text: "Réponse automatique" };
    }

    if (firstChoice.input === "number") {
        return { number: 42 };
    }

    if (question.allowMultiple) {
        const selectedChoices = question.choices.slice(0, 2).map((choice) => choice.id);
        return { choiceIds: selectedChoices.length > 0 ? selectedChoices : [firstChoice.id] };
    }

    return { choiceIds: [firstChoice.id] };
}

async function loadForm() {
    try {
        const response = await fetch(`${serverUrl}/forms/${formId}`);
        if (!response.ok) {
            console.error("Failed to fetch form", response.status, response.statusText);
            return null;
        }
        return response.json();
    } catch (error) {
        console.error("Error fetching form", error);
        return null;
    }
}
