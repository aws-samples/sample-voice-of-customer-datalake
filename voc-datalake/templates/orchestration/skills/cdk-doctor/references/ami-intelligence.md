# AMI and Container Image Intelligence

## Version-First Principle

Before installing ANY software: check what the base AMI/image already includes. Only upgrade if incompatible.

## Deep Learning AMI (DLAMI) Contents

AWS DLAMIs pre-install multiple framework versions in isolated Conda environments:

| Component | Typical Versions | Check command (on the instance: a person's check) |
|---|---|---|
| CUDA Toolkit | 11.8, 12.1, 12.4 | `ls /usr/local/cuda*` |
| cuDNN | Matching CUDA versions | `cat /usr/local/cuda/include/cudnn_version.h` |
| NCCL | Multi-GPU communication | `dpkg -l | grep nccl` |
| PyTorch | Pre-compiled for CUDA | `conda activate pytorch && python -c "import torch; print(torch.__version__)"` |
| TensorFlow | Pre-compiled for CUDA | `conda activate tensorflow && python -c "import tensorflow; print(tensorflow.__version__)"` |
| Python | 3.10, 3.11, 3.12 | `python3 --version` |
| NVIDIA driver | 535+, 550+ | `nvidia-smi` |

## CUDA/GPU Compatibility

### Instance Type → GPU

| Instance Type | GPU | Compute Capability | Use Case |
|---|---|---|---|
| g4dn.* | T4 | 7.5 (Turing) | Inference, light training |
| g5.* | A10G | 8.6 (Ampere) | Training, inference |
| p4d.24xlarge | A100 | 8.0 (Ampere) | Large-scale training |
| p5.48xlarge | H100 | 9.0 (Hopper) | LLM training |
| g6.* | L4 | 8.9 (Ada) | Inference |

### CUDA → Framework Compatibility

| CUDA | Min Driver | PyTorch | TensorFlow | Triton | FlashInfer |
|---|---|---|---|---|---|
| 12.4 | 550.54+ | 2.2+ | 2.16+ | 3.5+ | 0.5+ |
| 12.1 | 530.30+ | 2.1+ | 2.14+ | 3.0+ | 0.4+ |
| 11.8 | 520.61+ | 2.0+ | 2.12+ | 2.0+ | 0.3+ |

### Version Check Before Upgrading

```bash
# What CUDA is installed?
nvcc --version
nvidia-smi  # shows driver version and max CUDA supported

# What PyTorch expects
python3 -c "import torch; print(torch.version.cuda)"

# What FlashInfer needs
python3 -c "import flashinfer; flashinfer.show_config()" 2>/dev/null || echo "Not installed"
```

**Decision rule**: If the installed CUDA version satisfies your framework's minimum, do NOT upgrade. CUDA upgrades risk breaking other pre-installed frameworks.

## Container Base Image Selection

### Python ML Images

| Image | Size | Pre-installed | Best For |
|---|---|---|---|
| `python:3.12-slim` | ~150 MB | Python only | API services, no ML |
| `nvidia/cuda:12.1.0-runtime-ubuntu22.04` | ~3 GB | CUDA runtime | Inference with custom deps |
| `nvidia/cuda:12.1.0-devel-ubuntu22.04` | ~5 GB | CUDA + compiler | Building from source |
| AWS DL Container (ECR public) | ~8 GB | CUDA + PyTorch/TF | Full ML stack |

### Inspecting an Image

Image metadata (tags, sizes) lives in its registry, which the sandbox cannot reach. Choose a base image from what
the repository already pins and from the table above, name the tag and the reason in your finish, and leave a
registry check (ECR Public, Docker Hub) to a person.

## ECS-Optimized AMI Contents

| Component | Version (typical) | Notes |
|---|---|---|
| Amazon Linux 2 / AL2023 | Latest | Auto-updated via SSM |
| Docker | 20.10+ / 25+ | Managed by ECS agent |
| ECS agent | Latest | Auto-updated |
| nvidia-container-runtime | Included in GPU AMI | Required for GPU tasks |

### GPU ECS Setup Checklist

- [ ] Use ECS GPU-optimized AMI (SSM: `/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended`)
- [ ] Instance type has GPU (g4dn, g5, p4d, p5)
- [ ] Task definition specifies GPU resource requirements
- [ ] Container has NVIDIA runtime configured
- [ ] CUDA version in container matches driver on host
