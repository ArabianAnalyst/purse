export interface WireRequest {
  id: string;
  method: "request" | "execute" | "status";
  params: unknown;
}
export interface WireResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface AgentChannel {
  send(msg: WireRequest): void;
  onMessage(cb: (msg: WireResponse) => void): void;
  onClose(cb: () => void): void;
}
