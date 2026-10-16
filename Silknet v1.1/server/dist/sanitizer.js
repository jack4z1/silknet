// Silknet Privacy & Redaction Shield
// Strips local file system paths, usernames, IP addresses, and sensitive secrets
// before any prompt reaches browser AI tabs.
export class PrivacyShield {
    static SECRET_PATTERNS = [
        { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9_-]{20,}/g },
        { name: 'Generic API Key/Secret', regex: /(?:api[_-]?key|secret|token|password|auth|bearer)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{12,})["']?/gi },
        { name: 'Private Key Block', regex: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g },
        { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
        { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
    ];
    static IP_PATTERN = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
    static WINDOWS_USER_PATH_PATTERN = /[a-zA-Z]:\\Users\\[^\\]+\\([^\s"'\n\r]+)/gi;
    static UNIX_USER_PATH_PATTERN = /\/(?:home|Users)\/[^\/]+\/([^\s"'\n\r]+)/gi;
    static sanitize(text, customUsername) {
        let clean = text;
        const redactionsSummary = [];
        let redactedCount = 0;
        // 1. Redact Secrets & API Keys
        for (const pattern of this.SECRET_PATTERNS) {
            if (pattern.regex.test(clean)) {
                clean = clean.replace(pattern.regex, () => {
                    redactedCount++;
                    return `[REDACTED_${pattern.name.toUpperCase().replace(/\s+/g, '_')}]`;
                });
                redactionsSummary.push(pattern.name);
            }
        }
        // 2. Redact IP addresses
        if (this.IP_PATTERN.test(clean)) {
            clean = clean.replace(this.IP_PATTERN, (ip) => {
                if (ip === '127.0.0.1' || ip === '0.0.0.0')
                    return '[LOCALHOST]';
                redactedCount++;
                return '[IP_REDACTED]';
            });
            redactionsSummary.push('IP Addresses');
        }
        // 3. Redact Specific Username
        const userEnv = customUsername || process.env.USERNAME || process.env.USER;
        if (userEnv && userEnv.length > 2) {
            const userRegex = new RegExp(`\\b${escapeRegExp(userEnv)}\\b`, 'gi');
            if (userRegex.test(clean)) {
                clean = clean.replace(userRegex, '[USER]');
                redactedCount++;
                redactionsSummary.push('Local Username');
            }
        }
        // 4. Redact Paths
        clean = clean.replace(this.WINDOWS_USER_PATH_PATTERN, (_match, relativePath) => {
            redactedCount++;
            return `[PROJECT]/${relativePath.replace(/\\/g, '/')}`;
        });
        clean = clean.replace(this.UNIX_USER_PATH_PATTERN, (_match, relativePath) => {
            redactedCount++;
            return `[PROJECT]/${relativePath}`;
        });
        return {
            cleanText: clean,
            redactedCount,
            redactionsSummary: Array.from(new Set(redactionsSummary)),
        };
    }
}
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
