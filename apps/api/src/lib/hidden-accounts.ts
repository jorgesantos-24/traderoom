/**
 * Accounts used for testing in production: what they do stays in the database but is left out
 * of the admin "Auditoria", "Logs" and "Online" screens, so test actions do not clutter the real history.
 * Lower-case e-mails.
 */
export const HIDDEN_FROM_LOGS: readonly string[] = ['jorgeplayerpt@gmail.com', 'fefofewggv@gmail.com'];

/**
 * Accounts left out of the admin "Resultados" (house results): their orders, deposits and withdrawals
 * do not count in any number there. Lower-case e-mails.
 */
export const HIDDEN_FROM_RESULTS: readonly string[] = ['jorge.m.santos2002@gmail.com', 'jc793450@gmail.com', 'viannaoperacional@gmail.com'];
