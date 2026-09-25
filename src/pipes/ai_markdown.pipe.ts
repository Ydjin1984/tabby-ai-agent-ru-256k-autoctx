import { Pipe, PipeTransform } from "@angular/core";
import { DomSanitizer, SafeHtml } from "@angular/platform-browser";
import { escapeHtml, renderMarkdown } from "../lib/markdown_renderer";

@Pipe({
  name: "aiMarkdown",
})
export class AIMarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(content: string | null | undefined): SafeHtml {
    if (!content) return "";
    try {
      return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(content));
    } catch (error) {
      console.error("Markdown parsing error:", error);
      return this.sanitizer.bypassSecurityTrustHtml(escapeHtml(content));
    }
  }
}
