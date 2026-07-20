<%@ Page Language="C#" AutoEventWireup="true" %>
<!DOCTYPE html>
<html>
<head>
  <title>Default</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
</head>
<body style="min-width: 1024px;">
  <div style="display:none;"><a href="#main">Skip to main</a></div>
  <main id="main">
  <h1>Fixture</h1>
  <img src="/logo.png">
  <img src="/icons/edit.png" alt="icon_16.gif">
  <img id="logo" class="productLogo" src="<%=WebConfiguration.LogoFile %>" alt="<%=GetAltTextForLogo() %>"/>
  <a href="#"></a>
  <a href="#"><%=GetLinkText()%></a>
  <a href="/foo">click here</a>
  <a href="/bar">click here</a>
  <button type="button"></button>
  <button type="button"><%: GetButtonText() %></button>
   <a href="/hotkeys" accesskey="h">Hotkey Link</a>
 
  <div class="treeNode" onclick="toggleNode();"><span>Node</span></div>
  <div class="contextMenuTarget" oncontextmenu="showContextMenu(event);">Right click me</div>
  <a class="menuAction" href="#" onclick="openMenu();"><svg focusable="false" viewBox="0 0 16 16"></svg></a>
  <svg focusable="false" width="16" height="16"></svg>
  <svg role="img"><path d="M0 0h8v8z"/></svg>
  <object data="movie.swf"></object>
  <embed src="legacy-player" />
  <div class="toast disabled" disabled="disabled">Disabled state on div</div>
  <div aria-hidden="true"><button type="button">Hidden action</button></div>

  <label for="missing-control">Detached label</label>
  <label>  </label>
  <label>Lonely label text</label>

  <fieldset>
    <div>content before legend</div>
    <legend>Options</legend>
    <input id="opt1" type="checkbox" />
  </fieldset>

  <select>
    <optgroup>
      <option>Item</option>
    </optgroup>
  </select>

  <table id="captionLate">
    <tr><th id="hdr1">Name</th><td headers="missingHdr">Value</td></tr>
    <caption>Late caption</caption>
  </table>

  <div aria-controls="unknownPanel" aria-labeledby="HdrX" aria-expanded="yes" role="superbutton">Broken aria attrs</div>
  <div role="heading">Missing level heading role</div>
  <div role="tab">Orphan tab</div>
  <div role="radiogroup"><span>group without radios</span></div>
  <div role="checkbox">Custom checkbox missing state</div>
  <div role="slider" aria-valuenow="10"></div>
  <div role="presentation" tabindex="0" onclick="doThing()">Clickable presentational</div>

  <h2>Section heading</h2>
  <h4>Skipped heading level</h4>
  <h3><img src="/decorative.png" alt="" /></h3>
  <div tabindex="0">Focusable div without role</div>

  <iframe title="" src="/frame"></iframe>
  <iframe src="/untitled-frame"></iframe>
  <select onchange="window.location=this.value"><option value="/next">Go</option></select>
  <div onfocus="window.location='/danger'" tabindex="0">Focusable redirect</div>
  <input type="email" id="contactEmail" />
  <input type="text" id="usernameField" />
  <input type="text" id="nickname" placeholder="Nickname" />
  <input type="text" id="zip" pattern="[0-9]{5}" />
  <input type="password" id="pwd" onpaste="return false;" />
   <input id="firstName" autofocus />
  <input type="text" id="requiredName" required />
  <input type="text" id="readonlyStatus" readonly />
  <form method="POST">
    <input type="text" name="query" placeholder="Search" required />
  </form>
  <input type="date" id="eventDate" />
  <form method="POST" id="actionForm">
    <button type="submit" name="action" value="save">Save</button>
    <button type="submit" name="action" value="delete">Delete</button>
  </form>
  <button type="button" disabled aria-disabled="false">Conflicting disabled states</button>
  <div aria-label="Save" aria-labelledby="lblSave">Dual name sources</div>

  <asp:TextBox ID="EmailBox" runat="server" TextMode="Email" aria-label="email" />
  <asp:GridView ID="GridBad" runat="server" UseAccessibleHeader="false" />
  <asp:Menu ID="MainMenu" runat="server" />
  <asp:DropDownList ID="NavList" runat="server" AutoPostBack="true" />
  <asp:RequiredFieldValidator ID="Req1" runat="server" ControlToValidate="TxtName" />
  <asp:ValidationSummary ID="ValSummary" runat="server" />
  <asp:UpdateProgress ID="Progress1" runat="server"><ProgressTemplate>Loading…</ProgressTemplate></asp:UpdateProgress>

  <div class="error-message">This field is required</div>
  <span class="validation-error" id="nameError">Name is invalid</span>
  
  <label for="ageField">Age <input type="number" id="ageField" required /></label>

  <marquee>Scrolling news</marquee>

  <%-- asp:Image without AlternateText --%>
  <asp:Image ID="Hero" runat="server" ImageUrl="~/hero.png" />

  <%-- asp:ImageButton without AlternateText --%>
  <asp:ImageButton ID="ImgBtn1" runat="server" ImageUrl="~/btn.png" />

  <%-- asp:ImageMap without AlternateText --%>
  <asp:ImageMap ID="Map1" runat="server" ImageUrl="~/map.png" />

  <%-- asp:HyperLink with no Text and no inner content --%>
  <asp:HyperLink ID="Link1" runat="server" NavigateUrl="~/page.aspx" />

  <%-- asp:LinkButton with no Text --%>
  <asp:LinkButton ID="LnkBtn1" runat="server" />

  <%-- asp:Button with no Text --%>
  <asp:Button ID="Btn1" runat="server" />

  <%-- asp:CheckBox with no Text --%>
  <asp:CheckBox ID="Chk1" runat="server" />

  <%-- asp:RadioButton with no Text --%>
  <asp:RadioButton ID="Rdo1" runat="server" />

  <%-- asp:TextBox with no associated label --%>
  <asp:TextBox ID="TxtName" runat="server" />

  <%-- asp:TextBox that IS labelled (should not fire) --%>
  <asp:Label ID="LblEmail" runat="server" AssociatedControlID="TxtEmail" Text="Email" />
  <asp:TextBox ID="TxtEmail" runat="server" />

  <%-- heading-like Label and onclick Panel --%>
  <asp:Label ID="LblHeading" runat="server" CssClass="panelTitle">Accounts</asp:Label>
  <asp:Panel ID="PnlFilter" runat="server" CssClass="divider expandShrink" onclick="toggleFilter();">
    <span>Filter</span>
  </asp:Panel>

  <%-- dialog-like markup missing dialog semantics --%>
  <div class="popup confirmDialog">
    <h2>Delete item</h2>
    <p>Are you sure?</p>
  </div>

  <%-- layout table without presentation role --%>
  <table runat="server" class="reportTable">
    <tr>
      <td><span>Row content</span></td>
    </tr>
  </table>

  <%-- duplicate heading to trigger multiple-h1 heuristic --%>
  <h1>Second heading</h1>
  </main>
</body>
</html>
