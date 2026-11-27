import { CURRENT_BRAND, type BrandBarLinks, type BrandId } from "~/lib/brand-bar";

const BRANDS: { id: BrandId | null; name: string; hrefKey: keyof BrandBarLinks }[] = [
  { id: "kerastase", name: "Kérastase", hrefKey: "kerastase" },
  { id: "la-roche-posay", name: "La Roche-Posay", hrefKey: "laRochePosay" },
  { id: null, name: "The House", hrefKey: "home" },
];

export function BrandBar({ links }: { links: BrandBarLinks }) {
  return (
    <div className="bg-black text-xs tracking-[0.12em] text-white uppercase">
      <p className="px-3 py-[9px] text-center text-[10px] tracking-[0.14em] md:hidden">
        2 complimentary samples of your choice
      </p>
      <div className="mx-auto hidden max-w-[1360px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-10 py-2.5 md:flex">
        <div className="flex flex-wrap items-center gap-5">
          <span className="text-[#B3B3B3]">One bag:</span>
          {BRANDS.map((brand) => {
            const active = CURRENT_BRAND === brand.id;
            return (
              <a
                key={brand.name}
                href={links[brand.hrefKey]}
                aria-current={active ? "page" : undefined}
                className={`focus-visible:outline-white text-white no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 ${active ? "underline underline-offset-4" : ""}`}
              >
                {brand.name}
              </a>
            );
          })}
        </div>
        <span>2 complimentary samples of your choice</span>
        <span>Find a salon</span>
      </div>
    </div>
  );
}
