# Restore a snapshot TAR offline

Download a DropVault snapshot TAR, then run:

```sh
npm run restore:snapshot -- snapshot.tar ./restored-handoff
```

The destination must be a new directory. The command checks the TAR structure, sizes, and SHA-256 checksums before writing files. It refuses unsafe original filenames, path traversal, and colliding output names. A failed extraction removes its temporary directory.

The result contains the original `manifest.json`, `assets/` with the original folder paths and filenames, and, for a snapshot linked to a code archive, `code/code.zip`. The ZIP is the exact stored version. It is an export of committed files, not a Git clone or repository history. Extract it separately if you want to inspect its contents. Asset paths are relative to `assets/`; the command cannot determine where they belong in a game engine or research project.

This command does not access DropVault or GitHub, authenticate the author of the snapshot, or verify that the linked commit exists upstream. It verifies the bytes against checksums recorded in the TAR itself. Get the TAR from a trusted source when provenance matters.
