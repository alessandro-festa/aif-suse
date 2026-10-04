# Jupyter on your machine with the rancher-ai SDK

> Running JupyterLab inside the cluster instead: `sdk/python/deploy/notebook.sh` (see the
> [SDK README](../README.md#jupyter-in-the-cluster)).

Run JupyterLab as a container on your own machine, with the `rancher-ai` SDK installed, connected
to Rancher with your own API key. From a notebook you can then list profiles, start training runs,
follow their logs and call inference endpoints, with exactly the permissions you have in the
Rancher UI.

Nothing is installed on your machine apart from a container runtime and a clone of the repository.

## 1. Container runtime

Any runtime with a `docker`-compatible command line works:

- **Rancher Desktop** (macOS, Windows, Linux): Preferences → Container Engine → **dockerd (moby)**,
  so the `docker` commands below work. With containerd, use `nerdctl` in place of `docker`; the
  flags are the same. Kubernetes in Rancher Desktop is not needed for this and can be turned off.
- **Docker Desktop** (macOS, Windows, Linux) or **Docker Engine** (Linux) work as they are.
- **Podman**: use `podman` in place of `docker`.

The commands below are for a POSIX shell (macOS, Linux, or WSL on Windows). In Windows PowerShell,
write `${HOME}` for `~` and end continued lines with a backtick instead of `\`.

## 2. Get the code

Clone the repository (or a git bundle of it) to `~/aif`:

```sh
git clone <repository or bundle> ~/aif
```

The SDK is in `sdk/python` of this repository.

## 3. Start JupyterLab

```sh
mkdir -p ~/jupyter-notebooks
cp ~/aif/sdk/python/examples/rancher-ai-demo.ipynb ~/jupyter-notebooks/
docker run -d --name jupyterlab -p 8888:8888 \
  -v ~/jupyter-notebooks:/home/jovyan/work \
  -v ~/aif/sdk/python:/sdk:ro \
  quay.io/jupyter/base-notebook:latest
```

- The image is Project Jupyter's: neither the SUSE Application Collection nor the SUSE registry
  ships JupyterLab.
- `~/jupyter-notebooks` is your notebook folder; it appears in Jupyter as `work/`.
- The SDK source is mounted read-only at `/sdk`, so nothing has to be built on your machine.
  Rancher Desktop and Docker Desktop share your home folder with containers by default; on Linux
  with SELinux enforcing (Fedora, RHEL), add `:z` to each `-v` option so the container can read
  the folders.
- Optional: to save files straight into your Downloads folder (a diagnostics bundle or a model
  adapter copied off a checkpoint volume, for example), add one more mount before the image name:
  ```sh
    -v ~/Downloads:/home/jovyan/Downloads \
  ```
  Then `vol.get("<file>", "/home/jovyan/Downloads")` in a notebook writes to `~/Downloads` on your
  machine. Without it, `~` in the notebook is the container's home, not yours, and files land
  beside the notebook in `~/jupyter-notebooks`. Adding a mount to an existing container means
  `docker rm jupyterlab`, a new `docker run`, and step 4 again.

## 4. Install the SDK in the container

```sh
docker exec jupyterlab bash -c 'cp -r /sdk /tmp/sdk && pip install -q /tmp/sdk pandas'
```

The copy is there because pip builds the package in its source folder, and the mount is read-only.
`pandas` makes profile lists show as tables.

## 5. Open Jupyter

```sh
docker logs jupyterlab 2>&1 | grep -m1 'http://127.0.0.1:8888/lab?token='
```

Open that link (it carries the login token). Don't paste the token anywhere shared.

## 6. Check the container can reach Rancher

Your machine must be on a network that reaches Rancher (or on its VPN). Test from inside the
container:

```sh
docker exec jupyterlab python -c "import socket; socket.create_connection(('rancher.example.com', 443), 3); print('ok')"
```

## 7. Create a Rancher API key

Rancher → avatar (top right) → **Account & API Keys** →
**Create API Key**:

- **Scope: No Scope.** A key scoped to one cluster cannot use Rancher's catalog API, which is how
  the SDK starts training runs.
- **Expires:** something short, e.g. 30 days.

Rancher shows the key once. Copy the **Bearer Token** (`token-xxxxx:yyyy...`); that whole value is
your token. It acts as you until it expires or you delete it on the same page.

## 8. Trust Rancher's certificate

If Rancher's certificate is signed by a private CA or is self-signed, save its CA certificate into
the notebook folder (Rancher publishes it without a login):

```sh
curl -sk https://rancher.example.com/v3/settings/cacerts | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' > ~/jupyter-notebooks/rancher-ca.pem
```

The hostname in `RANCHER_URL` must be one the certificate is issued for (its subject alternative
names). A Rancher with a publicly trusted certificate needs none of this.

## 9. Connect from a notebook

Save the token in the notebook folder, outside any notebook, e.g. `~/jupyter-notebooks/.rancher-token`.
Then open `work/rancher-ai-demo.ipynb` and, in the first cell, before `Client(...)`:

```python
import os
os.environ.update(RANCHER_URL="https://rancher.example.com",
                  RANCHER_TOKEN=open("/home/jovyan/work/.rancher-token").read().strip(),
                  RANCHER_CLUSTER="local",
                  RANCHER_CA_CERT="/home/jovyan/work/rancher-ca.pem")   # only with step 8

from rancher_ai import Client
ai = Client(project="team-a")         # your project namespace
ai.whoami()                           # should show your Rancher user
```

- `RANCHER_CLUSTER`: the cluster id from Rancher's URLs (`/c/<id>/...`); `local` is the cluster
  Rancher itself runs on.
- `RANCHER_INSECURE="1"` in place of `RANCHER_CA_CERT` disables certificate verification. Limit it
  to development or disposable environments.
- Keep the token out of notebooks you share or commit.

Then run the rest of the notebook: list profiles, start a training run, watch it, chat with an
endpoint.

## Permissions

What you can do is what your Rancher user can do. A user needs, in the project, the **AI Job
Submitter** role and, on the cluster, **AI Scheduler Cluster Read**. Without them:

- `ai.endpoints.table()` fails with *not allowed to list aiworkloads...*;
- inference profiles show `-` for scale and the SDK warns it cannot read blueprints.

A platform admin adds them in Rancher: the project's **Members** (AI Job Submitter) and the
cluster's **Cluster Members** (AI Scheduler Cluster Read).

## Updating the SDK

After pulling new commits into `~/aif`:

```sh
docker exec jupyterlab bash -c 'rm -rf /tmp/sdk && cp -r /sdk /tmp/sdk && pip install -q --force-reinstall --no-deps /tmp/sdk'
```

Then restart the notebook kernel (Kernel → Restart).

The new code is only used after the restart: a running kernel keeps the version it imported.
To check which one a notebook has:

```python
import rancher_ai
rancher_ai.__file__        # where it is installed
```

### A container without the `/sdk` mount

If the container was started without `-v ~/aif/sdk/python:/sdk:ro`, `pip install ~/aif/...` from
a notebook fails with *File '/home/jovyan/aif/sdk/python' does not exist*: in the container `~` is
`/home/jovyan`, and your machine's folders are only visible where they are mounted. Copy the SDK
in from a terminal on your machine instead:

```sh
docker exec jupyterlab rm -rf /tmp/sdk
docker cp ~/aif/sdk/python jupyterlab:/tmp/sdk
docker exec -u root jupyterlab chown -R 1000:100 /tmp/sdk
docker exec jupyterlab pip install -q --force-reinstall --no-deps /tmp/sdk
```

and restart the kernel. This keeps the running container and your notebooks. `docker cp` copies
as root, which is why the files are handed to the notebook user (`jovyan`, 1000:100) before the
install.

### Adding a mount later

Docker cannot add a mount to an existing container. To add the `/sdk` mount (so updates are the
one command above) or the Downloads mount from step 3, recreate the container. Notebooks in
`~/jupyter-notebooks` are kept; running kernels stop, and the login token changes.

```sh
docker rm -f jupyterlab
docker run -d --name jupyterlab -p 8888:8888 \
  -v ~/jupyter-notebooks:/home/jovyan/work \
  -v ~/aif/sdk/python:/sdk:ro \
  -v ~/Downloads:/home/jovyan/Downloads \
  quay.io/jupyter/base-notebook:latest
docker exec jupyterlab bash -c 'cp -r /sdk /tmp/sdk && pip install -q /tmp/sdk pandas'
docker logs jupyterlab 2>&1 | grep -m1 'http://127.0.0.1:8888/lab?token='
```

Open the new link. To see what an existing container has mounted:

```sh
docker inspect jupyterlab --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

## Keeping the setup

- `docker stop jupyterlab` / `docker start jupyterlab`, or restarting your machine, keeps the SDK
  install.
- `docker rm jupyterlab` and a new `docker run` loses it: repeat step 4. Notebooks in
  `~/jupyter-notebooks` survive either way.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 Unauthorized`, response header `X-Api-Cattle-Auth: false` | The token was not accepted: copy the whole Bearer Token, and check it has No Scope and has not expired. |
| `SSLError: certificate verify failed` | Rancher's certificate is not trusted: do step 8 and set `RANCHER_CA_CERT`, and check the URL's hostname matches the certificate. |
| `PermissionError: not allowed to list ...` | Your user lacks a role; see Permissions. |
| `chat()` fails with `Model '' not found` | The SDK could not read the endpoint's blueprint (a missing role); fix the role, or pass `model="..."`. |
| `'Checkpoint' object has no attribute 'get'`, or another missing method | The kernel has an older SDK: reinstall (see Updating the SDK) and restart the kernel. |
| `Invalid requirement: '/home/jovyan/...'`, *does not exist* | The path is on your machine, not in the container; see A container without the `/sdk` mount. |
| Connection refused / timeout to Rancher | Your machine cannot reach Rancher, or the URL is wrong; run the check in step 6. |
