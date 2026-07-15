import { Button } from "../ui/button";

export function ComposerSuggestions(props: {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
}) {
  if (props.suggestions.length === 0) return null;
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {props.suggestions.map((suggestion) => (
        <Button
          key={suggestion}
          variant="outline"
          size="xs"
          type="button"
          className="max-w-full truncate"
          title={suggestion}
          onClick={() => props.onSelect(suggestion)}
        >
          {suggestion}
        </Button>
      ))}
    </div>
  );
}
