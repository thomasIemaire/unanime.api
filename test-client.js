import { io } from "socket.io-client";

const socket = io("http://localhost:8080", {
    transports: ["websocket"],
    auth: { participantId: "user-123" }
});

const formId = "ia_sondage_live_001";

socket.on("connect", () => {
    console.log("✅ connected:", socket.id);
    socket.emit('join_form', { formId, role: 'admin', hostSessionCode: 'ADMIN42' });

    // poser la Q courante (ex: 0,0)
    socket.emit('admin:set_question', { formId, sectionIndex: 0, itemIndex: 0 });

    // lancer (timer si configuré)
    socket.emit('admin:start_question', { formId });

    // révéler résultats
    socket.emit('admin:reveal', { formId, show: true });

    // passer à la suivante (si tu désactives l’avance auto)
    socket.emit('admin:next', { formId });
});

socket.on("state", (s) => console.log("STATE", s));
socket.on("error_msg", (e) => console.error("ERR", e));
socket.on("disconnect", (r) => console.log("disconnected:", r));
