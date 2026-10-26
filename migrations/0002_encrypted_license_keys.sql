-- Key hashes validate activations. This ciphertext is only for an authenticated
-- administrator to reveal a key that was previously issued.
ALTER TABLE licenses ADD COLUMN key_ciphertext TEXT;
