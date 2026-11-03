# Known-good control in the same Mix project (#3405): it must compile clean, so a
# publish for lib/bad.ex is the seeded error and not a broken project.
defmodule Smoke.Good do
  def hello, do: :world
end
