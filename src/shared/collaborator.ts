// How a Collaborator shows to the others: a display name and a colour, as a number into `colors`.
export type Collaborator = { name: string; color: number };

// Every colour a Collaborator can have, each dark enough for white text on it. Clients send a number into this list,
// never a colour, so nothing a client sends is written into CSS (ADR 0007).
export const colors = ["#b91c1c", "#c2410c", "#a16207", "#15803d", "#0f766e", "#1d4ed8", "#6d28d9", "#be185d"];

const maxName = 50; // code points
// A name as the others see it: without control, format or line-breaking characters, which can hide or reorder text,
// trimmed, at most `maxName` code points. The Server accepts only a name this leaves unchanged.
export const displayName = (text: string) => [...text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim()].slice(0, maxName).join("").trim();
