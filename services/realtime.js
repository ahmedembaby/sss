// Holds the socket.io instance + presence so routes can emit events without circular requires.
let io = null;
const online = new Map(); // userId -> number of open sockets

const setIO = (instance) => { io = instance; };
const getIO = () => io;

const emitToConversation = (conversationId, event, payload) => {
  if (io) io.to(`conv_${conversationId}`).emit(event, payload);
};
const emitToUser = (userId, event, payload) => {
  if (io) io.to(`user_${userId}`).emit(event, payload);
};
const emitToUsers = (userIds, event, payload) => {
  (userIds || []).forEach((id) => emitToUser(id, event, payload));
};
const isOnline = (userId) => (online.get(Number(userId)) || 0) > 0;

const disconnectSession = (sessionId) => { if (io && sessionId) io.in(`session_${sessionId}`).disconnectSockets(true); };

const disconnectUser = (userId) => {
  if (!io) return;
  io.in(`user_${userId}`).disconnectSockets(true);
};

module.exports = { setIO, getIO, online, emitToConversation, emitToUser, emitToUsers, isOnline, disconnectUser, disconnectSession };
