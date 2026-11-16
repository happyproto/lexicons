-- @prelude json
--
-- record.index:at.happyproto.preferences.contact
--
-- Indexes nothing. These records live only in accounts' preferences spaces
-- (HAP-463), which HappyView never hands to a record index script. The
-- lexicon is deployed so the shape is published, and that also subscribes
-- this instance to the collection on the network; a copy someone publishes
-- to a public repo is dropped here, so nothing from the network is stored.

function handle(input, ctx)
  return nil
end
