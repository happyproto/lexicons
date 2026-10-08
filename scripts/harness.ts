/**
 * Stub modules, a JSON-ish encoder to report results with, and recorders for
 * what the prelude asked HappyView to do. Tests steer the stubs through the
 * `__` globals before calling a helper.
 *
 * Shared by prelude.test.ts and createSpaces.test.ts. Not a test file, so
 * importing it registers no tests.
 */
export const HARNESS = String.raw`
local function __encode(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if math.type(v) == "integer" then return tostring(v) end
    return string.format("%.17g", v)
  end
  if t == "string" then
    return '"' .. (v:gsub('[%c"\\]', function(c)
      return string.format("\\u%04x", c:byte())
    end)) .. '"'
  end
  if t == "table" then
    local count = 0
    for _ in pairs(v) do count = count + 1 end
    if count > 0 and count == #v then
      local items = {}
      for i = 1, #v do items[i] = __encode(v[i]) end
      return "[" .. table.concat(items, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local items = {}
    for _, k in ipairs(keys) do
      local value = v[k]
      if value == nil then value = v[tonumber(k)] end
      items[#items + 1] = __encode(k) .. ":" .. __encode(value)
    end
    return "{" .. table.concat(items, ",") .. "}"
  end
  return '"<' .. t .. '>"'
end

__log = {}
__calls = {}
__access = function(uri, did) return nil end
__reply = function(method, url, opts) return { status = 200, body = "", headers = {} } end
__decoded = {}

package.preload["internal.json"] = function()
  return {
    encode = __encode,
    decode = function(s)
      local v = __decoded[s]
      if v == nil then error("invalid json: " .. tostring(s)) end
      return v
    end,
    to_array = function(t) return t end,
  }
end

package.preload["internal.logging"] = function()
  local function at(level)
    return function(message, fields)
      __log[#__log + 1] = { level = level, message = message, fields = fields }
    end
  end
  return { debug = at("debug"), info = at("info"), warn = at("warn"), error = at("error") }
end

package.preload["happyview.spaces"] = function()
  return {
    get = function(uri)
      return {
        access = function(_, did)
          __calls[#__calls + 1] = { fn = "access", uri = uri, did = did }
          return __access(uri, did)
        end,
      }
    end,
  }
end

__job = function(job_type, input) return "job-0001" end

package.preload["happyview.jobs"] = function()
  return {
    create = function(job_type, input, opts)
      __calls[#__calls + 1] = { fn = "create", job_type = job_type, input = input, opts = opts }
      return __job(job_type, input)
    end,
  }
end

package.preload["happyview.http"] = function()
  local m = {}
  for _, name in ipairs({ "get", "post", "put", "patch", "delete", "head" }) do
    m[name] = function(url, opts)
      __calls[#__calls + 1] = { fn = name, url = url, opts = opts }
      return __reply(name, url, opts)
    end
  end
  return m
end
`;
