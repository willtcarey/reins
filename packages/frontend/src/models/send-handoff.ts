import type { SendAnimationSource } from "../helpers/chat-send-animation.js";

/** A message sent from a composer on another page, to animate into its session's conversation. */
export interface HandedOffSend {
  sessionId: string;
  /** The message's key in the conversation. */
  messageKey: string;
  /** Where the composer's prompt box was when the message was sent. */
  source: SendAnimationSource;
}

/**
 * The one message the new session page sent last, until the session's chat panel takes it. A message
 * handed off later replaces it: only the newest page change animates.
 */
export class SendHandoff {
  private sent: HandedOffSend | null = null;

  give(sent: HandedOffSend): void {
    this.sent = sent;
  }

  /** The message sent to the session, once: a later take gets nothing. */
  take(sessionId: string): HandedOffSend | null {
    const sent = this.sent;
    if (sent?.sessionId !== sessionId) return null;
    this.sent = null;
    return sent;
  }
}
