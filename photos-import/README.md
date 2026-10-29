Encrypted body photos (AES-256-GCM, nonce + ciphertext, the date as associated data). Only the server
decrypts them, through the `import_body_photos` MCP tool with a key that is never stored in git; the
photos then live in data/photos on the server. Safe to delete this folder after the import.
