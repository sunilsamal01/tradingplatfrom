import { api } from "./api.js";

export const groupApi = {
  list: () => api.get("/groups"),
  create: (b) => api.post("/groups", b),
  join: (code) => api.post("/groups/join", { code }),
  members: (id) => api.get(`/groups/${id}/members`),
  messages: (id, before) => api.get(`/groups/${id}/messages${before ? `?before=${before}` : ""}`),
  send: (id, b) => api.post(`/groups/${id}/messages`, b),
  read: (id) => api.post(`/groups/${id}/read`, {}),
  edit: (id, content) => api.patch(`/groups/messages/${id}`, { content }),
  remove: (id) => api.del(`/groups/messages/${id}`),
  invite: (id, email) => api.post(`/groups/${id}/invitations`, { email }),
};

export function connectSocket(token) {
  // Lazy-load socket.io-client only where needed.
  return import("socket.io-client").then(({ io }) =>
    io(api.base.replace(/\/api$/, ""), { auth: { token }, transports: ["websocket"] })
  );
}
