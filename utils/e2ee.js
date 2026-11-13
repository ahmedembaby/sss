const PREFIX = 'e2ee:v1:';

// The mobile client encodes nonce + authenticated ciphertext as base64 after this prefix.
const isEncrypted = (content) => typeof content === 'string'
  && content.startsWith(PREFIX)
  && /^[A-Za-z0-9+/]+={0,2}$/.test(content.slice(PREFIX.length))
  && content.length - PREFIX.length >= 56;

// End-to-end encryption is optional. Direct conversations accept ordinary text messages.
// isEncrypted remains available so clients can still decrypt messages created by older app versions.
const requiresEncryption = () => false;

module.exports = { PREFIX, isEncrypted, requiresEncryption };