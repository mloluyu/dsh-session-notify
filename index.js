/**
 * Host entry point of the session-notify bundle.
 *
 * All notification work happens in the page (client.js): an in-app card
 * when the user is in the GUI but looking elsewhere, and a page-raised
 * system notification (browser Notification API — under the DSH app's own
 * identity in the desktop build) when the page is unfocused. Nothing is
 * sent when no page is open; that is by design.
 *
 * This module deliberately does nothing. It exists only so the bundle
 * registers as a host plugin, which is what makes the web GUI load the
 * client half.
 */
export const name = 'session-notify'

export function apply() {}
