import { api, getAccessToken } from "./api.js";

// Community / chat API client. Base path: /community
export const communityApi = {
  // Conversations (inbox + DMs)
  conversations: (filter) => api.get(`/community/conversations${filter && filter !== "all" ? `?filter=${filter}` : ""}`),
  startDirect: (userId) => api.post("/community/conversations/direct", { userId }),
  conversation: (id) => api.get(`/community/conversations/${id}`),
  create: (body) => api.post("/community/conversations", body),
  update: (id, body) => api.patch(`/community/conversations/${id}`, body),
  join: (id, token) => api.post(`/community/conversations/${id}/join`, { token }),
  leave: (id) => api.post(`/community/conversations/${id}/leave`, {}),

  // Messages
  messages: (id, before, limit = 50, topicId) =>
    api.get(`/community/conversations/${id}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}${topicId ? `&topicId=${topicId}` : ""}`),
  send: (id, body) => api.post(`/community/conversations/${id}/messages`, body),
  search: (id, q) => api.get(`/community/conversations/${id}/search?q=${encodeURIComponent(q)}`),
  pinned: (id) => api.get(`/community/conversations/${id}/pinned`),
  markRead: (id, messageId) => api.post(`/community/conversations/${id}/read`, { messageId }),
  editMessage: (mid, content) => api.patch(`/community/messages/${mid}`, { content }),
  deleteMessage: (mid, forMe = false) => api.del(`/community/messages/${mid}${forMe ? "?forMe=true" : ""}`),
  react: (mid, emoji) => api.post(`/community/messages/${mid}/reactions`, { emoji }),
  pin: (mid) => api.post(`/community/messages/${mid}/pin`, {}),
  unpin: (mid) => api.del(`/community/messages/${mid}/pin`),

  // Members & moderation
  members: (id, { q, skip = 0, limit = 50 } = {}) =>
    api.get(`/community/conversations/${id}/members?skip=${skip}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  updateMember: (id, userId, patch) => api.patch(`/community/conversations/${id}/members/${userId}`, patch),
  removeMember: (id, userId) => api.del(`/community/conversations/${id}/members/${userId}`),
  ban: (id, userId) => api.post(`/community/conversations/${id}/ban/${userId}`, {}),
  unban: (id, userId) => api.del(`/community/conversations/${id}/ban/${userId}`),

  // Join requests
  requestJoin: (id, message) => api.post(`/community/conversations/${id}/join-requests`, { message }),
  joinRequests: (id) => api.get(`/community/conversations/${id}/join-requests`),
  reviewJoin: (id, requestId, approve) => api.patch(`/community/conversations/${id}/join-requests/${requestId}`, { approve }),

  // Invites
  createInvite: (id, opts) => api.post(`/community/conversations/${id}/invites`, opts || {}),
  invites: (id) => api.get(`/community/conversations/${id}/invites`),
  revokeInvite: (id, inviteId) => api.del(`/community/conversations/${id}/invites/${inviteId}`),
  peekInvite: (token) => api.get(`/community/invites/${token}`),
  joinByInvite: (token) => api.post(`/community/invites/${token}/join`, {}),

  // Topics
  topics: (id) => api.get(`/community/conversations/${id}/topics`),
  createTopic: (id, body) => api.post(`/community/conversations/${id}/topics`, body),

  // Discovery & search
  discover: ({ q, category, limit = 20 } = {}) =>
    api.get(`/community/discover?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${category ? `&category=${encodeURIComponent(category)}` : ""}`),
  categories: () => api.get("/community/categories"),
  searchUsers: (q) => api.get(`/community/users/search?q=${encodeURIComponent(q)}`),

  // Reports & notifications
  report: (body) => api.post("/community/reports", body),
  notifications: () => api.get("/community/notifications"),
  readNotification: (id) => api.patch(`/community/notifications/${id}/read`, {}),
  readAllNotifications: () => api.post("/community/notifications/read-all", {}),

  // Media upload (multipart)
  upload: (file, onProgress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append("file", file);
      xhr.open("POST", `${api.base}/community/upload`);
      const token = getAccessToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data?.data || data);
        else reject({ message: data?.message || `Upload failed (${xhr.status})`, status: xhr.status });
      };
      xhr.onerror = () => reject({ message: "Network error during upload" });
      xhr.send(fd);
    }),
};

// Resolve a relative uploaded URL (or avatar) to an absolute one.
const API_ROOT = api.base.replace(/\/api$/, "");
export const resolveMedia = (u) => (!u ? null : /^https?:|^data:|^blob:/.test(u) ? u : `${API_ROOT}${u}`);

// Lazy socket connection (socket.io-client) with a shared instance to avoid
// duplicate connections across components.
let socketPromise = null;
export function connectCommunitySocket() {
  if (socketPromise) return socketPromise;
  const token = getAccessToken();
  const url = api.base.replace(/\/api$/, "");
  socketPromise = import("socket.io-client").then(({ io }) =>
    io(url, { auth: { token }, transports: ["websocket"], reconnection: true, reconnectionAttempts: 8 })
  );
  return socketPromise;
}
export function disconnectCommunitySocket() {
  socketPromise?.then?.((s) => s.disconnect()).catch(() => {});
  socketPromise = null;
}
