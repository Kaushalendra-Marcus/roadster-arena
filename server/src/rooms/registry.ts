/**
 * In-process room registry — enforces the per-process caps from config/rooms.json
 * (spec 7.10) and powers the /health endpoint. One ArenaRoom per arena; the
 * module is a process-wide singleton.
 */

export interface RoomRecord {
  roomId: string;
  players: number;
  maxPlayers: number;
  createdAt: number;
}

const rooms = new Map<string, RoomRecord>();

export function registerRoom(record: RoomRecord): void {
  rooms.set(record.roomId, record);
}

export function unregisterRoom(roomId: string): void {
  rooms.delete(roomId);
}

export function setPlayerCount(roomId: string, players: number): void {
  const record = rooms.get(roomId);
  if (record) record.players = Math.max(0, players);
}

export function roomCount(): number {
  return rooms.size;
}

export function playerTotal(): number {
  let total = 0;
  for (const r of rooms.values()) total += r.players;
  return total;
}

export function snapshot(): RoomRecord[] {
  return [...rooms.values()].map((r) => ({ ...r }));
}
