# Windows support

Mona Agent supports Windows through a native Windows Service Control Manager adapter, foreground CLI execution, and a PowerShell installer. Windows support follows Microsoft's active security-support lifecycle: a release is supported only while Microsoft still provides security updates for it.

## Support matrix

| Windows release | Status | Notes |
|---|---|---|
| Windows 11 23H2 / 24H2 | Supported | Current consumer lifecycle; x64 and ARM64 Node. |
| Windows Server 2022 | Supported | Mainstream/ESU dates per Microsoft lifecycle. |
| Windows Server 2025 | Supported | Current server lifecycle. |
| Windows 10 22H2 | Supported only while Microsoft ships security updates | EOL releases are explicitly unsupported for production. |
| End-of-life releases (Win10 < 22H2, Server 2016/2019 after ESU, etc.) | Blocked | The installer refuses EOL releases by policy; never deploy production agents there. |

Support claims are validated against Microsoft's published lifecycle data at release time; an unknown lifecycle status must be reviewed before enterprise deployment.

## Requirements

- Windows release within the matrix above.
- Node.js 20 or newer (x64 or ARM64 build).
- Administrator elevation for `daemon install`, update, and uninstall.
- Windows 10+ built-in `tar.exe` for release archive extraction (used by the installer).

## Install

```powershell
irm https://agent.mona.expert/install.ps1 | iex               # main branch
irm https://agent.mona.expert/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v2.11.0                               # pinned release
```

Release-tag installs download the exact release asset and fail closed unless it verifies against one valid matching `SHA256SUMS` entry. Branch installs are unversioned and unverified by design.

## Native service

```powershell
mona-agent start                 # foreground
mona-agent daemon install        # elevated PowerShell → registers the SCM service
mona-agent daemon status
mona-agent daemon stop
mona-agent daemon uninstall
```

The service is named `MonaAgent`, uses automatic delayed start, and configures restart recovery. Uninstall removes only the service registration; user data, policy, audit, and credentials remain.

### Service account and credential scope

- Default identity is **LocalSystem**. The service runs with a **different user profile** (`C:\Windows\System32\config\systemprofile`), so its `~\.mona-agent` data directory — credentials, policy, audit, memory, runs — is **separate** from the interactive user's directory.
- Credential storage uses Windows DPAPI. Interactive runs use `DataProtectionScope.CurrentUser`; the service context (`MONA_SERVICE=windows-scm`) uses `DataProtectionScope.LocalMachine` so service-saved credentials are decryptable by the service.
- Consequences, by design:
  - credentials saved interactively are **not** readable by the LocalSystem service and vice versa;
  - policy is per data directory: install policy in the service profile before enabling remote tasks;
  - the audit trail is per data directory too.
- The service adapter accepts `LocalSystem`, `NT AUTHORITY\LocalService`, `NT AUTHORITY\NetworkService`, or one named `DOMAIN\User` account. **Passwords are never passed on a command line.** If you need a named account, configure it through Service Manager, then keep DPAPI scope consistent (`MONA_SERVICE` selects LocalMachine automatically).
- To run the service as your interactive user instead, register it with your account via SCM and review DPAPI scope behavior in `credentials.js`.

## Security boundaries

- Shell execution is **argv-only**: commands are parsed quote-aware, executables resolve through PATH/PATHEXT and the allowlist, and the child env is scrubbed. `cmd.exe` builtins (`dir`, `ver`, …) are intentionally **not** executed through `cmd /c`; the small in-process builtins `echo`, `type`, `cd` run inside the agent under the same allowlist, and `type` is confined to the working directory.
- No user-controlled string is ever passed to `powershell.exe -Command` or `cmd.exe /c`. Service operations pass **parameterized** arguments (`-File … -Action …`), never raw input.
- Windows process-tree containment, ACL/reparse-point hardening, and signed MSI/MSIX packaging require validation on real Windows runners before enterprise certification; current CI runs the full suite on `windows-latest` and a CLI smoke test, which is necessary but not sufficient for certification.

## CI and release gates

- CI runs the full test suite plus CLI smoke tests on `windows-latest` (see `.github/workflows/ci.yml`).
- Releases must not claim Windows certification for a build unless the matrix above was exercised on a matching Windows image and the release notes say which images were used.
- The release artifact for Windows users is the signed-and-attested source tarball consumed by `install.ps1`. Code-signing for a native MSI/MSIX remains a release prerequisite tracked in the implementation backlog.
