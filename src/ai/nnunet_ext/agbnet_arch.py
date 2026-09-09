"""
AGB-Net -- Anatomy-Guided Bilateral Network for thin-structure BAT segmentation.

Every module below answers a deficiency that was *measured* on Dataset601, not a
generic architecture idea.  See batnet/README.md for the numbers.

  (1) ACC-FiLM  Anatomical Coordinate FiLM conditioning
      Why: BAT's intensity signature is biologically unstable (relative position
           between muscle and white fat, p5..p95 spread 0.45, not removable by
           any normalisation), while its *location* is extremely stable
           (centroid SD 5/10/18 mm in body-box coordinates).  A 96^3 patch
           carries no positional information, so the baseline is forced to rely
           on the unstable cue -- which is exactly how it loses whole depots
           (worst case Dice 0.043, 10326 FN voxels up to 146 mm away).
      What: sinusoidal expansion of the three coordinate channels -> a light
           parallel encoder -> per-stage spatial (gamma, beta) modulating every
           encoder skip.  A slowly-varying ramp fed as a plain input channel is
           washed out by successive convolutions; FiLM guarantees it reaches
           every depth.

  (2) BSF  Bilateral Symmetry Fusion
      Why: supraclavicular BAT is never unilateral.  L/R volume ratio is 0.95
           (median) and > 0.5 in 100 % of 150 measured cases.  If one depot is
           visible the contralateral one is essentially guaranteed.
      What: at mid-resolution encoder stages, reflect the feature map about the
           subject's own mid-sagittal plane -- recovered analytically from the
           left-right coordinate channel, so it is correct under nnU-Net's
           random cropping, rotation and mirroring -- and fuse it back through a
           learned gate.  Evidence on one side is thereby transported to the
           other.

  (3) TSR  Thin-Structure Refinement head
      Why: BAT half-thickness is 1.75 mm = ONE voxel at the planned spacing, so
           essentially every voxel is a boundary voxel, and 72-92 % of all
           FP/FN sit within 2 mm of the surface.  This is what caps every model
           near 0.88 regardless of backbone.
      What: a full-resolution multi-dilation depthwise branch that sees the
           finest decoder features, the raw intensities and the coarse logits,
           and emits a *residual* correction to the logits.  Zero-initialised,
           so training starts exactly at the backbone's own solution.

Backbone is nnU-Net's ResidualEncoderUNet, driven entirely by the plans file, so
the network still scales itself to the dataset the way nnU-Net intends.
"""
from typing import List, Tuple, Type, Union

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.checkpoint import checkpoint
from dynamic_network_architectures.architectures.unet import ResidualEncoderUNet
from dynamic_network_architectures.initialization.weight_init import InitWeights_He, init_last_bn_before_add_to_0


# --------------------------------------------------------------------------- #
#  helpers
# --------------------------------------------------------------------------- #
def _sinusoidal(coords: torch.Tensor, n_bands: int = 4) -> torch.Tensor:
    """(B, K, *sp) coordinate ramps -> (B, K*(2*n_bands+1), *sp) Fourier features.

    A linear ramp is a very weak signal for a stack of 3x3x3 convolutions; the
    sinusoidal expansion makes position sharply decodable at several scales.
    The raw ramp is kept as well so absolute position stays available.
    """
    feats = [coords]
    for k in range(n_bands):
        f = (2.0 ** k) * np.pi
        feats.append(torch.sin(f * coords))
        feats.append(torch.cos(f * coords))
    return torch.cat(feats, dim=1)


def _norm_grids(x: torch.Tensor, n_lead: int = 2) -> List[torch.Tensor]:
    """Per-axis grid_sample coordinates in [-1, 1], shaped to broadcast."""
    sp = x.shape[n_lead:]
    out = []
    for a, S in enumerate(sp):
        g = torch.linspace(-1.0, 1.0, S, device=x.device, dtype=torch.float32)
        shape = [1] * len(sp)
        shape[a] = S
        out.append(g.view(1, *shape))
    return out


def estimate_midsagittal(coord_lr: torch.Tensor):
    """Recover the subject's mid-sagittal plane from the left-right coordinate channel.

    coord_lr is an affine ramp over the body bounding box that equals 0.5 at the
    body midline and is 0 outside the body. nnU-Net transports it through
    cropping, resampling, rotation, scaling and mirroring together with the
    image, so fitting it inside the patch recovers the plane *after* augmentation.

    We fit  coord(u) ~= n . u + b  by mask-weighted least squares over the terms
    (u0, u1, u2, 1) in grid_sample coordinates, giving the plane ``n . u = c``
    with ``c = 0.5 - b``.

    Fitting the full 3-D plane rather than one axis matters: nnU-Net rotates by
    up to 30 degrees, which displaces an axis-aligned approximation of the plane
    by ~35 mm at the edge of a 128-voxel patch -- enough to put a whole depot on
    the wrong side of the bilateral split.

    Returns (normal (B, 3), offset (B,), confidence (B,)).
    """
    with torch.no_grad():
        x = coord_lr[:, 0].float()
        B = x.shape[0]
        nsp = x.dim() - 1
        red = tuple(range(1, nsp + 1))

        grids = _norm_grids(x, n_lead=1)

        # The quantity being fitted is an affine ramp, so a strided subsample
        # determines it just as well as every voxel and costs ~8x less. The grids
        # are sliced identically rather than rebuilt, so the coordinate frame -
        # and therefore the fitted offset - stays exact.
        step = 2 if min(x.shape[1:]) >= 32 else 1
        if step > 1:
            sl = (slice(None),) + (slice(None, None, step),) * nsp
            x = x[sl]
            grids = [g[(slice(None),) + (slice(None, None, step),) * nsp] for g in grids]

        w = (x > 0).float()
        k = nsp + 1
        one = torch.ones((), device=x.device)

        def f(i):
            return grids[i] if i < nsp else one

        A = x.new_zeros(B, k, k)
        rhs = x.new_zeros(B, k)
        for i in range(k):
            rhs[:, i] = (w * x * f(i)).sum(red)
            for j in range(i, k):
                v = (w * f(i) * f(j)).sum(red)
                A[:, i, j] = v
                A[:, j, i] = v

        scale = A.diagonal(dim1=1, dim2=2).abs().amax(1).clamp(min=1e-6).view(-1, 1, 1)
        A = A + 1e-6 * scale * torch.eye(k, device=x.device).unsqueeze(0)
        try:
            sol = torch.linalg.solve(A, rhs.unsqueeze(-1)).squeeze(-1)
        except Exception:
            sol = torch.zeros(B, k, device=x.device)

        n = sol[:, :nsp]
        c = 0.5 - sol[:, nsp]
        nn2 = (n * n).sum(1)
        # a usable plane needs a real gradient, enough body in the patch, and must
        # not sit far outside the patch itself
        dist = c.abs() / nn2.clamp(min=1e-8).sqrt()
        conf = ((nn2 > 1e-4) & (w.sum(red) > 32) & (dist < 2.0)).float()
        return n, c, conf


def signed_distance(shape, n: torch.Tensor, c: torch.Tensor, device) -> torch.Tensor:
    """(B, 1, *spatial) value of  n . u - c  on the grid of `shape`. Sign = side."""
    dummy = torch.empty((1, 1) + tuple(shape[2:]), device=device)
    grids = _norm_grids(dummy, n_lead=2)
    nsp = len(grids)
    view = (-1,) + (1,) * nsp
    d = 0.0
    for a in range(nsp):
        d = d + n[:, a].view(view) * grids[a]
    return (d - c.view(view)).unsqueeze(1)


def _reflect(x: torch.Tensor, n: torch.Tensor, c: torch.Tensor) -> torch.Tensor:
    """Mirror `x` about the plane  n . u = c :   u' = u - 2 (n.u - c) n / |n|^2.

    Regions whose mirror image falls outside the patch come back as zeros, which
    is the correct "no contralateral evidence here" signal for the gate.
    """
    nsp = x.dim() - 2
    grids = _norm_grids(x, n_lead=2)
    view = (-1,) + (1,) * nsp
    d = 0.0
    for a in range(nsp):
        d = d + n[:, a].view(view) * grids[a]
    d = d - c.view(view)
    fac = 2.0 * d / (n * n).sum(1).clamp(min=1e-8).view(view)
    mesh = [grids[a].expand(x.shape[0], *x.shape[2:]) - fac * n[:, a].view(view)
            for a in range(nsp)]
    grid = torch.stack(mesh[::-1], dim=-1)      # grid's last dim is reversed spatial order
    return F.grid_sample(x.float(), grid, mode="bilinear",
                         padding_mode="zeros", align_corners=True).to(x.dtype)


# --------------------------------------------------------------------------- #
#  (1) Anatomical Coordinate FiLM
# --------------------------------------------------------------------------- #
class AnatomicalFiLM(nn.Module):
    """Light parallel encoder over the coordinate channels producing per-stage
    spatial (gamma, beta) that modulate the main encoder's skips."""

    def __init__(self, n_coord: int, features_per_stage: List[int], strides,
                 conv_op, norm_op, norm_op_kwargs, nonlin, nonlin_kwargs,
                 n_bands: int = 4, width_div: int = 8, min_width: int = 8,
                 modulate_stages: Tuple[int, ...] = None):
        super().__init__()
        c_in = n_coord * (2 * n_bands + 1)
        self.n_bands = n_bands
        n = len(features_per_stage)
        # Stage 0 lives at full patch resolution, where a 2*C modulation tensor is
        # by far the most expensive activation in this module while modulating only
        # low-level texture features. Default to stages 1..n-1.
        self.modulate = tuple(range(1, n)) if modulate_stages is None else tuple(modulate_stages)
        widths = [max(min_width, f // width_div) for f in features_per_stage]

        self.stages = nn.ModuleList()
        self.heads = nn.ModuleDict()
        prev = c_in
        for i, (f, wdt) in enumerate(zip(features_per_stage, widths)):
            self.stages.append(nn.Sequential(
                conv_op(prev, wdt, kernel_size=3, stride=tuple(strides[i]), padding=1, bias=False),
                norm_op(wdt, **(norm_op_kwargs or {})),
                nonlin(**(nonlin_kwargs or {})),
            ))
            if i in self.modulate:
                head = conv_op(wdt, 2 * f, kernel_size=1, bias=True)
                nn.init.zeros_(head.weight)
                nn.init.zeros_(head.bias)      # start as identity modulation
                self.heads[str(i)] = head
            prev = wdt

    def forward(self, coords: torch.Tensor) -> List[Tuple[torch.Tensor, torch.Tensor]]:
        h = _sinusoidal(coords, self.n_bands)
        out = []
        for i, st in enumerate(self.stages):
            h = st(h)
            if str(i) in self.heads:
                g, b = self.heads[str(i)](h).chunk(2, dim=1)
                out.append((g, b))
            else:
                out.append(None)
        return out


# --------------------------------------------------------------------------- #
#  (2) Bilateral Symmetry Fusion
# --------------------------------------------------------------------------- #
class BilateralSymmetryFusion(nn.Module):
    def __init__(self, channels: int, conv_op, norm_op, norm_op_kwargs, nonlin, nonlin_kwargs):
        super().__init__()
        self.mix = nn.Sequential(
            conv_op(2 * channels, channels, kernel_size=1, bias=False),
            norm_op(channels, **(norm_op_kwargs or {})),
            nonlin(**(nonlin_kwargs or {})),
        )
        self.gate = nn.Sequential(conv_op(2 * channels, channels, kernel_size=1, bias=True),
                                  nn.Sigmoid())
        self.out = conv_op(channels, channels, kernel_size=1, bias=True)
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)          # starts as a no-op

    def forward(self, x, n: torch.Tensor, c: torch.Tensor, conf: torch.Tensor):
        xm = _reflect(x, n, c)
        cat = torch.cat([x, xm], dim=1)
        upd = self.out(self.mix(cat)) * self.gate(cat)
        c = conf.view(-1, *([1] * (x.dim() - 1)))
        return x + c * upd


# --------------------------------------------------------------------------- #
#  (3) Thin-Structure Refinement
# --------------------------------------------------------------------------- #
class ThinStructureRefinement(nn.Module):
    def __init__(self, in_features: int, n_img_channels: int, num_classes: int,
                 conv_op, norm_op, norm_op_kwargs, nonlin, nonlin_kwargs,
                 width: int = 32, dilations: Tuple[int, ...] = (1, 2, 3),
                 checkpointing: bool = True):
        super().__init__()
        c_in = in_features + n_img_channels + num_classes
        self.proj = nn.Sequential(
            conv_op(c_in, width, kernel_size=1, bias=False),
            norm_op(width, **(norm_op_kwargs or {})),
            nonlin(**(nonlin_kwargs or {})),
        )
        self.branches = nn.ModuleList([
            conv_op(width, width, kernel_size=3, padding=d, dilation=d,
                    groups=width, bias=False) for d in dilations           # depthwise
        ])
        self.merge = nn.Sequential(
            conv_op(width, width, kernel_size=1, bias=False),              # pointwise
            norm_op(width, **(norm_op_kwargs or {})),
            nonlin(**(nonlin_kwargs or {})),
        )
        self.out = conv_op(width, num_classes, kernel_size=1, bias=True)
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)          # residual starts at zero
        self.checkpoint = checkpointing

    def _body(self, feat, img, logits):
        h = self.proj(torch.cat([feat, img, logits], dim=1))
        h = self.merge(sum(br(h) for br in self.branches))      # sum, not concat
        return self.out(h)

    def forward(self, feat, img, logits):
        # This block runs at full patch resolution, where activations dominate the
        # whole network's memory. Recomputing it in the backward pass costs a few
        # per cent of step time and frees several GiB.
        if self.checkpoint and self.training and torch.is_grad_enabled():
            r = checkpoint(self._body, feat, img, logits, use_reentrant=False)
        else:
            r = self._body(feat, img, logits)
        return logits + r


# --------------------------------------------------------------------------- #
#  AGB-Net
# --------------------------------------------------------------------------- #
class AGBNet(nn.Module):
    def __init__(self,
                 input_channels: int,
                 n_stages: int,
                 features_per_stage,
                 conv_op,
                 kernel_sizes,
                 strides,
                 n_blocks_per_stage,
                 num_classes: int,
                 n_conv_per_stage_decoder,
                 conv_bias: bool = False,
                 norm_op=None, norm_op_kwargs: dict = None,
                 dropout_op=None, dropout_op_kwargs: dict = None,
                 nonlin=None, nonlin_kwargs: dict = None,
                 deep_supervision: bool = False,
                 # --- AGB-Net specific ---
                 n_coord_channels: int = 3,
                 use_film: bool = True,
                 use_bsf: bool = True,
                 use_tsr: bool = True,
                 bsf_stages: Tuple[int, ...] = (2, 3),
                 tsr_width: int = 32,
                 tsr_dilations: Tuple[int, ...] = (1, 2, 3),
                 film_stages: Tuple[int, ...] = None,
                 tsr_checkpointing: bool = True,
                 ctx=None,
                 **kwargs):
        super().__init__()
        self.n_coord = n_coord_channels
        self.n_img = input_channels - n_coord_channels
        assert self.n_img >= 1, "input_channels must exceed n_coord_channels"
        self.use_film = use_film and n_coord_channels > 0
        self.use_bsf = use_bsf and n_coord_channels > 0
        self.use_tsr = use_tsr
        self.ctx = ctx                       # shared holder read by the loss

        backbone = ResidualEncoderUNet(
            input_channels=input_channels, n_stages=n_stages,
            features_per_stage=features_per_stage, conv_op=conv_op,
            kernel_sizes=kernel_sizes, strides=strides,
            n_blocks_per_stage=n_blocks_per_stage, num_classes=num_classes,
            n_conv_per_stage_decoder=n_conv_per_stage_decoder, conv_bias=conv_bias,
            norm_op=norm_op, norm_op_kwargs=norm_op_kwargs,
            dropout_op=dropout_op, dropout_op_kwargs=dropout_op_kwargs,
            nonlin=nonlin, nonlin_kwargs=nonlin_kwargs,
            deep_supervision=deep_supervision, **kwargs)
        # nnU-Net's He init, applied to the backbone only: the AGB heads are
        # deliberately zero-initialised so training starts at the backbone's own
        # solution and each module has to earn its contribution.
        backbone.apply(ResidualEncoderUNet.initialize)
        self.encoder = backbone.encoder
        self.decoder = backbone.decoder          # nnU-Net toggles .decoder.deep_supervision

        fps = list(features_per_stage) if not isinstance(features_per_stage, int) \
            else [features_per_stage] * n_stages
        strides_l = strides if not isinstance(strides, int) else [strides] * n_stages
        strides_l = [s if isinstance(s, (list, tuple)) else [s] * (2 if conv_op is nn.Conv2d else 3)
                     for s in strides_l]

        if self.use_film:
            self.film = AnatomicalFiLM(n_coord_channels, fps, strides_l, conv_op,
                                       norm_op, norm_op_kwargs, nonlin, nonlin_kwargs,
                                       modulate_stages=film_stages)

        self.bsf_stages = tuple(s for s in bsf_stages if 0 <= s < n_stages) if self.use_bsf else ()
        if self.bsf_stages:
            self.bsf = nn.ModuleDict({
                str(s): BilateralSymmetryFusion(fps[s], conv_op, norm_op, norm_op_kwargs,
                                                nonlin, nonlin_kwargs)
                for s in self.bsf_stages})

        if self.use_tsr:
            self.tsr = ThinStructureRefinement(fps[0], input_channels, num_classes,
                                               conv_op, norm_op, norm_op_kwargs,
                                               nonlin, nonlin_kwargs,
                                               width=tsr_width, dilations=tsr_dilations,
                                               checkpointing=tsr_checkpointing)

    # ------------------------------------------------------------------ #
    def _decode(self, skips):
        """Same as UNetDecoder.forward but also hands back the finest feature map."""
        dec = self.decoder
        lres = skips[-1]
        segs = []
        for s in range(len(dec.stages)):
            x = dec.transpconvs[s](lres)
            x = torch.cat((x, skips[-(s + 2)]), 1)
            x = dec.stages[s](x)
            if dec.deep_supervision:
                segs.append(dec.seg_layers[s](x))
            elif s == (len(dec.stages) - 1):
                segs.append(dec.seg_layers[-1](x))
            lres = x
        return segs[::-1], lres

    def forward(self, x):
        coords = x[:, self.n_img:] if self.n_coord > 0 else None

        pn = pc = conf = None
        if (self.bsf_stages or self.ctx is not None) and self.n_coord > 0:
            pn, pc, conf = estimate_midsagittal(coords[:, 0:1])
            if self.ctx is not None:
                self.ctx.plane_n, self.ctx.plane_c, self.ctx.plane_conf = pn, pc, conf

        skips = self.encoder(x)

        if self.use_film:
            mods = self.film(coords)
            skips = [s if m is None else s * (1.0 + m[0].to(s.dtype)) + m[1].to(s.dtype)
                     for s, m in zip(skips, mods)]

        if self.bsf_stages:
            skips = list(skips)
            for s in self.bsf_stages:
                skips[s] = self.bsf[str(s)](skips[s], pn, pc, conf)

        segs, feat = self._decode(skips)

        if self.use_tsr:
            segs[0] = self.tsr(feat, x, segs[0])

        return segs if self.decoder.deep_supervision else segs[0]

    def compute_conv_feature_map_size(self, input_size):
        return self.encoder.compute_conv_feature_map_size(input_size) + \
               self.decoder.compute_conv_feature_map_size(input_size)
