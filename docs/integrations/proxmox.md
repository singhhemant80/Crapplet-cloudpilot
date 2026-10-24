# Proxmox VE setup

CloudPilot talks to Proxmox only through the official REST API (`https://<host>:8006/api2/json`)
with an **API token** scoped to a least-privilege role. It never uses SSH or root passwords.

## 1. Role, user and token (run on any cluster node)

```bash
pveum role add CloudPilot -privs "VM.Allocate VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit \
  VM.Config.Disk VM.Config.Memory VM.Config.Network VM.Config.Options VM.Audit VM.PowerMgmt VM.Console \
  VM.Snapshot VM.Monitor Datastore.AllocateSpace Datastore.Audit Sys.Audit SDN.Use"
pveum user add cloudpilot@pve --comment "CloudPilot automation"
pveum aclmod / -user cloudpilot@pve -role CloudPilot
pveum user token add cloudpilot@pve automation --privsep 0
# → note the token secret (shown once). Token ID: cloudpilot@pve!automation
```

Tighten the ACL path (e.g. a resource pool `/pool/customers` plus the template VMs and target
storages) once you have confirmed the setup works.

> Proxmox 8 renamed some privileges (e.g. `VM.Monitor` was split). If `role add` rejects a name,
> run `pveum role list` and use the equivalent on your version.

## 2. Templates

CloudPilot clones **cloud-init VM templates**. For each OS:

```bash
qm create 9000 --name ubuntu-24.04-cloudinit --memory 1024 --cores 1 --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci
qm importdisk 9000 noble-server-cloudimg-amd64.img local-lvm
qm set 9000 --scsi0 local-lvm:vm-9000-disk-0 --ide2 local-lvm:cloudinit --boot order=scsi0 --serial0 socket --vga serial0 --agent enabled=1
qm template 9000
```

- Install `qemu-guest-agent` in the image: verification then checks the IP **inside** the guest
  (otherwise only the provider config is verified, and the order event says so).
- The disk must be `scsi0` (or set `options.diskName` on the provider, e.g. `virtio0`).
- Templates on non-shared storage must live on the same node as the product placement.

## 3. TLS

Paste the cluster CA (`/etc/pve/pve-root-ca.pem`) into "CA certificate" when adding the
hypervisor. "Skip TLS verification" exists for labs only and is logged as a warning.

## 4. Add in CloudPilot

Admin › Hypervisors › Add hypervisor → Test → Discover. Then Products › Placement to choose
node, storage, bridge, VLAN, IP pool and templates.

## Behaviour notes

| Topic | Behaviour |
|---|---|
| VM ids | `GET /cluster/nextid` at creation; the VM **name** (`cp-<order number>`) is the idempotency handle. |
| Duplicate names | Adapter refuses to create a second VM with the same name; provisioning adopts an existing one. |
| Network | `net0` = `virtio,bridge=<bridge>[,tag=<vlan>]` (existing MAC preserved on reconfigure); `ipconfig0` carries IPv4 and IPv6. |
| Disk | Grown to the plan size after clone; shrinking is refused. |
| Tasks | Every async call waits on its UPID; a failed task is a `ProviderError`, never success. |
| Not yet supported | LXC, reinstall, backup/restore, migration (capability not reported; calls throw). |
