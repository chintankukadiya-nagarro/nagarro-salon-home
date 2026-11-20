import {
  CURRENT_BRAND,
  KERASTASE_COLOR,
  LA_ROCHE_POSAY_COLOR,
  type BrandBarLinks,
  type BrandId,
} from "~/lib/brand-bar";

const BRANDS: { id: BrandId; name: string; color: string; hrefKey: keyof BrandBarLinks }[] = [
  { id: "la-roche-posay", name: "La Roche-Posay", color: LA_ROCHE_POSAY_COLOR, hrefKey: "laRochePosay" },
  { id: "kerastase", name: "Kérastase", color: KERASTASE_COLOR, hrefKey: "kerastase" },
];

export function BrandBar({ links }: { links: BrandBarLinks }) {
  return (
    <div className="bg-[#141414] text-white">
      <div className="max-w-page px-margin mx-auto flex h-10 items-center justify-between gap-4">
        <a
          href={links.home}
          aria-current={CURRENT_BRAND === null ? "page" : undefined}
          className="focus-visible:outline-white shrink-0 text-[11px] font-medium tracking-[0.16em] text-white/70 uppercase no-underline hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Beauty Diagnostics
        </a>
        <nav aria-label="Brands" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {BRANDS.map((brand) => {
            const active = CURRENT_BRAND === brand.id;
            return (
              <a
                key={brand.id}
                href={links[brand.hrefKey]}
                aria-current={active ? "page" : undefined}
                className={`focus-visible:outline-white shrink-0 rounded-full px-3 py-1 text-sm no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 motion-safe:transition-colors ${active ? "text-white" : "text-white/75 hover:text-white"}`}
                style={active ? { backgroundColor: brand.color } : undefined}
              >
                {brand.name}
              </a>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
