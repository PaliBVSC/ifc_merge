"""Write a large synthetic IFC4 file for performance testing.

Usage: python -m tests.make_large OUT.ifc COLUMNS [ORIGIN_X ORIGIN_Y]
About 450 bytes per column, so 1.2 million columns is roughly 550 MB.
"""
import sys

from app.step import new_guid

HEAD = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');
FILE_NAME('{name}','2026-01-01T00:00:00',(''),(''),'make_large','make_large','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('{g1}',$,'{name}',$,$,$,$,(#10),#2);
#2=IFCUNITASSIGNMENT((#3,#4));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCDIRECTION((0.,0.,1.));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCSITE('{g2}',$,'Site; with semicolon',$,$,#21,$,$,.ELEMENT.,(47,30,0,0),(19,2,0,0),0.,$,$);
#21=IFCLOCALPLACEMENT($,#24);
#22=IFCCARTESIANPOINT(({ox},{oy},0.));
#24=IFCAXIS2PLACEMENT3D(#22,$,$);
#30=IFCBUILDING('{g3}',$,'Building',$,$,#31,$,$,.ELEMENT.,$,$,$);
#31=IFCLOCALPLACEMENT(#21,#6);
#40=IFCBUILDINGSTOREY('{g4}',$,'Level 0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT(#31,#6);
#50=IFCRELAGGREGATES('{g5}',$,$,$,#1,(#20));
#51=IFCRELAGGREGATES('{g6}',$,$,$,#20,(#30));
#52=IFCRELAGGREGATES('{g7}',$,$,$,#30,(#40));
"""

COLUMN = (
    "#{p}=IFCCARTESIANPOINT(({x}.,{y}.,0.));\n"
    "#{a}=IFCAXIS2PLACEMENT3D(#{p},$,$);\n"
    "#{lp}=IFCLOCALPLACEMENT(#41,#{a});\n"
    "#{pr}=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,400.,400.);\n"
    "#{ex}=IFCEXTRUDEDAREASOLID(#{pr},$,#7,3000.);\n"
    "#{sr}=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#{ex}));\n"
    "#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{sr}));\n"
    "#{c}=IFCCOLUMN('{g}',$,'C{i}','it''s #{i}; really',$,#{lp},#{ps},$,.COLUMN.);\n"
)


def main(path, n, ox=0, oy=0):
    side = int(n ** 0.5) + 1
    with open(path, "w", newline="\n") as f:
        g = [new_guid().decode() for _ in range(7)]
        f.write(HEAD.format(name=path.replace("\\", "/").split("/")[-1], ox=float(ox) * 1000,
                            oy=float(oy) * 1000, g1=g[0], g2=g[1], g3=g[2], g4=g[3], g5=g[4],
                            g6=g[5], g7=g[6]))
        nid = 100
        cols = []
        buf = []
        for i in range(n):
            ids = dict(p=nid, a=nid + 1, lp=nid + 2, pr=nid + 3, ex=nid + 4, sr=nid + 5, ps=nid + 6, c=nid + 7)
            nid += 8
            buf.append(COLUMN.format(x=(i % side) * 1000, y=(i // side) * 1000, g=new_guid().decode(), i=i, **ids))
            cols.append(ids["c"])
            if len(buf) >= 10000:
                f.write("".join(buf))
                buf = []
        f.write("".join(buf))
        f.write("#%d=IFCRELCONTAINEDINSPATIALSTRUCTURE('%s',$,$,$,(%s),#40);\n"
                % (nid, new_guid().decode(), ",".join("#%d" % c for c in cols)))
        f.write("ENDSEC;\nEND-ISO-10303-21;\n")


if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[0], int(a[1]), *(float(x) for x in a[2:4]))
