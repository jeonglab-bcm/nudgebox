/**
 * What a changed file is, told from its path alone (SPEC 15): code a reviewer reads line by
 * line, a document, or something else (settings, tables, pictures, archives, lock files).
 */
export type FileKind = "code" | "doc" | "other";

const CODE = new Set(("py pyi pyx ipynb r jl m ts tsx mts cts js jsx mjs cjs vue svelte sh bash zsh fish ps1 bat cmd sbatch slurm pbs nf smk wdl cwl sql " +
	"c h cc cpp cxx hpp hh cs java kt kts scala groovy gradle go rs rb pl pm php swift lua hs ml ex exs erl clj f f90 f95 awk cmake mk proto " +
	"html htm css scss sass less").split(" "));
const DOC = new Set("md markdown mdx rmd qmd rst adoc tex".split(" "));
/** Code with no extension to tell it by. */
const CODE_NAMES = /^(makefile|gnumakefile|dockerfile|containerfile|snakefile|jenkinsfile|rakefile|gemfile|vagrantfile|justfile|cmakelists\.txt)$/i;
const DOC_NAMES = /^(readme|changelog|contributing|authors|notice)$/i;

export function fileKind(path: string): FileKind {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (CODE_NAMES.test(name) || /^(dockerfile|containerfile)\./i.test(name)) return "code";
	if (DOC_NAMES.test(name)) return "doc";
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	return CODE.has(ext) ? "code" : DOC.has(ext) ? "doc" : "other";
}
