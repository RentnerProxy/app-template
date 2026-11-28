-- Data version 2. The platform runs this step in one transaction as the schema owner, both for a
-- new installation (from version 0) and for Greeting 1.0 (from version 1, which kept its data in
-- files only). The runtime role may then read and change rows of every table in the app schema.
CREATE TABLE app.greeting_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    greeting text NOT NULL CHECK (char_length(greeting) BETWEEN 1 AND 120),
    saved_at timestamptz NOT NULL DEFAULT now()
);
