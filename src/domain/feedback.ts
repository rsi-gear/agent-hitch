export type MessageFeedbackRating = "positive" | "negative";
export type MessageFeedbackVersion = string;

export interface MessageFeedbackItem {
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
  version: MessageFeedbackVersion;
  createdAt: number;
  updatedAt: number;
}

export interface MessageFeedbackRow {
  session: {
    /** Session id binding: prevents a reused id from inheriting stale feedback. */
    sessionId?: string;
    createdAt: number;
    cwd?: string;
  };
  items: MessageFeedbackItem[];
}
