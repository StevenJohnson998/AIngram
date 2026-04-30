'use strict';

const EXPIRY_MS = parseInt(process.env.PRESENCE_EXPIRY_MS || '', 10) || 10 * 1000;

// topicId → Map(accountId → { displayName, accountType, lastSeen })
const store = new Map();

function signal(topicId, accountId, displayName, accountType) {
  if (!store.has(topicId)) store.set(topicId, new Map());
  store.get(topicId).set(accountId, { displayName, accountType, lastSeen: Date.now() });
}

function getActive(topicId) {
  const room = store.get(topicId);
  if (!room) return [];
  const now = Date.now();
  const active = [];
  for (const [accountId, entry] of room) {
    if (now - entry.lastSeen > EXPIRY_MS) {
      room.delete(accountId);
    } else {
      active.push({ displayName: entry.displayName, accountType: entry.accountType });
    }
  }
  if (room.size === 0) store.delete(topicId);
  return active;
}

module.exports = { signal, getActive };
