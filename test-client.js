import { io } from "socket.io-client";

const serverUrl = process.env.SERVER_URL ?? "http://localhost:8080";
const formId = process.env.FORM_ID ?? "ia_sondage_live_001";
const hostSessionCode = process.env.HOST_CODE ?? "ADMIN42";
const sectionIndex = Number.parseInt(process.env.SECTION_INDEX ?? "0", 10);
const itemIndex = Number.parseInt(process.env.ITEM_INDEX ?? "0", 10);

const socket = io(serverUrl, {
    transports: ["websocket"],
    auth: { participantId: process.env.ADMIN_ID ?? "admin-tester" }
});

const steps = [
    async () => {
        console.log("➡️  set question", { sectionIndex, itemIndex });
        socket.emit("admin:set_question", { formId, sectionIndex, itemIndex });
        await wait(750);
    },
    async () => {
        console.log("➡️  start question");
        socket.emit("admin:start_question", { formId });
        await wait(2000);
    },
    async () => {
        console.log("➡️  reveal results");
        socket.emit("admin:reveal", { formId, show: true });
        await wait(1500);
    },
    async () => {
        console.log("➡️  lock question");
        socket.emit("admin:lock", { formId, locked: true });
        await wait(1000);
    },
    async () => {
        console.log("➡️  advance to next question");
        socket.emit("admin:next", { formId });
        await wait(750);
    }
];

let runningScenario = false;

socket.on("connect", () => {
    console.log("✅ connected:", socket.id);
    socket.emit("join_form", { formId, role: "admin", hostSessionCode });
    if (!runningScenario) {
        runningScenario = true;
        runScenario().catch((error) => {
            console.error("Scenario failed", error);
            process.exitCode = 1;
        });
    }
});

socket.on("admin:dashboard", (payload) => {
    console.log("📊 admin dashboard", JSON.stringify(payload, null, 2));
});

socket.on("admin:results", (payload) => {
    console.log("📈 admin results", JSON.stringify(payload, null, 2));
});

socket.on("admin:explanation", (payload) => {
    console.log("🧠 admin explanation", JSON.stringify(payload, null, 2));
});

socket.on("state", (state) => {
    console.log("🛰️  state", JSON.stringify(state, null, 2));
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

async function runScenario() {
    for (const [index, step] of steps.entries()) {
        console.log(`\n--- Step ${index + 1}/${steps.length} ---`);
        await step();
    }
    console.log("✅ scenario completed");
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
